const ytDlp = require('yt-dlp-exec');
const ytSearch = require('yt-search');
const fs = require('fs');
const path = require('path');

// Load FFMPEG path for conversions
let ffmpegPath = '';
try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (e) {
    console.error('[YT-DLP] FFMPEG not found via installer. Searching system path...');
}

module.exports = {
    name: 'youtube',
    aliases: ['yt', 'video', 'ytv', 'yta', 'play', 'song'],
    category: 'Downloader',
    desc: 'Download YouTube Videos or Audio using yt-dlp',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg, wasi_args, wasi_text, sessionId } = context;
        const prefix = context.config?.prefix || '.';
        const cmd = wasi_text.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();

        let query = wasi_args.join(' ');
        if (!query) return await wasi_sock.sendMessage(wasi_sender, { text: `❌ Please provide a YouTube URL or search query.\n\nUsage:\n- ${prefix}ytv <url/search>\n- ${prefix}yta <url/search>` });

        await wasi_sock.sendMessage(wasi_sender, { text: `⏳ *Fetching from YouTube...*` }, { quoted: wasi_msg });

        const isAudio = ['yta', 'play', 'song'].includes(cmd);
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const tempFile = path.join(tempDir, `ytdl_${sessionId}_${Date.now()}.${isAudio ? 'mp3' : 'mp4'}`);
        let cookiesFile = null;

        try {
            let url = query;
            if (!query.includes('youtube.com') && !query.includes('youtu.be')) {
                const search = await ytSearch(query);
                if (!search.videos.length) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ No results found.' });
                url = search.videos[0].url;
            }

            // --- STRATEGY 1: External Scrapers (Best for Heroku) ---
            const { wasi_youtube } = require('../wasilib/scrapers');
            console.log(`[YT] Trying External Scrapers for ${url}...`);
            const scrapResult = await wasi_youtube(url, isAudio ? 'audio' : 'video');

            if (scrapResult.status && scrapResult.downloadUrl) {
                console.log(`[YT] Scraper Success (${scrapResult.provider})`);
                const { wasi_getBuffer } = require('../wasilib/fetch');
                const buffer = await wasi_getBuffer(scrapResult.downloadUrl);

                if (isAudio) {
                    return await wasi_sock.sendMessage(wasi_sender, {
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quoted: wasi_msg });
                } else {
                    return await wasi_sock.sendMessage(wasi_sender, {
                        video: buffer,
                        caption: `🎥 *YOUTUBE DOWNLOADER*\n\n📌 *Title:* ${scrapResult.title}\n🚀 *Provider:* ${scrapResult.provider}\n\n> WASI-MD-V7`
                    }, { quoted: wasi_msg });
                }
            }

            // --- STRATEGY 2: Local yt-dlp (Fallback) ---
            console.log(`[YT] Scrapers failed or returned no URL. Trying Local yt-dlp fallback...`);

            // Handle Cookies for Heroku/IP Blocks
            // Handle Cookies for Heroku/IP Blocks
            if (fs.existsSync(path.join(__dirname, '../cookies.json'))) {
                cookiesFile = path.join(__dirname, '../cookies.json');
                console.log('[YT] Using local cookies.json');
            } else if (context.config?.ytCookies) {
                if (fs.existsSync(context.config.ytCookies)) {
                    cookiesFile = context.config.ytCookies;
                }
                else if (context.config.ytCookies.includes('Netscape') || context.config.ytCookies.includes('google.com')) {
                    cookiesFile = path.join(tempDir, `cookies_${sessionId}_${Date.now()}.txt`);
                    let content = context.config.ytCookies.trim();
                    if (!content.includes('# Netscape HTTP Cookie File')) {
                        content = '# Netscape HTTP Cookie File\n' + content;
                    }
                    fs.writeFileSync(cookiesFile, content);
                }
            }

            const options = {
                output: tempFile,
                noCheckCertificates: true,
                noWarnings: true,
                addHeader: [
                    'referer:youtube.com',
                    `user-agent:${context.config?.ytUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}`
                ],
                userAgent: context.config?.ytUserAgent || undefined,
                ffmpegLocation: ffmpegPath || undefined,
                cookies: cookiesFile || undefined
            };

            if (isAudio) {
                options.extractAudio = true;
                options.audioFormat = 'mp3';
                options.format = 'bestaudio';
            } else {
                options.format = 'best[ext=mp4]/best';
                options.mergeOutputFormat = 'mp4';
            }

            try {
                await ytDlp(url, options);
            } catch (dlError) {
                throw new Error(`Download failed: ${dlError.message || 'Check logs'}`);
            }

            if (fs.existsSync(tempFile)) {
                const stats = fs.statSync(tempFile);
                if (stats.size / (1024 * 1024) > 100) {
                    return await wasi_sock.sendMessage(wasi_sender, { text: '❌ The file is too large to send (>100MB).' });
                }

                const buffer = fs.readFileSync(tempFile);
                if (isAudio) {
                    await wasi_sock.sendMessage(wasi_sender, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: wasi_msg });
                } else {
                    await wasi_sock.sendMessage(wasi_sender, { video: buffer, caption: `🎥 *YOUTUBE DOWNLOADER*\n\n> WASI-MD-V7` }, { quoted: wasi_msg });
                }
            } else {
                throw new Error('Fallback yt-dlp failed.');
            }

        } catch (e) {
            console.error(`[YT-DLP] Error:`, e.message);
            let errMsg = e.message || 'Failed to process YouTube request.';

            if (errMsg.includes('Sign in to confirm')) {
                errMsg = "❌ *YouTube Blocked the Request*\n\nYouTube requires authentication (cookies) to download from Heroku servers. Please add your YouTube cookies to the `YT_COOKIES` environment variable.";
            }

            await wasi_sock.sendMessage(wasi_sender, { text: errMsg });
        } finally {
            // Cleanup temp files
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                if (cookiesFile && cookiesFile.includes('cookies_') && fs.existsSync(cookiesFile)) {
                    fs.unlinkSync(cookiesFile);
                }
            } catch (cleanupErr) {
                console.error('[YT-DLP] Cleanup Error:', cleanupErr.message);
            }
        }
    }
};
