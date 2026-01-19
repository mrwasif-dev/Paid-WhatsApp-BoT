const { wasi_tiktok } = require('../wasilib/scrapers');

module.exports = {
    name: 'tiktok',
    aliases: ['tt', 'tik', 'tiktokdl'],
    category: 'Downloader',
    desc: 'Download TikTok videos without watermark',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, wasi_text } = context;

        let url = wasi_args[0];

        // Ensure URL is present
        if (!url) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please provide a TikTok URL.\n\nUsage: .tiktok https://vm.tiktok.com/...' });
        }

        // Validate URL
        if (!url.includes('tiktok.com')) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Invalid TikTok URL.' });
        }

        await wasi_sock.sendMessage(wasi_sender, { text: '⏳ *Fetching TikTok video...*' });

        try {
            const data = await wasi_tiktok(url);

            if (!data.status) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to download video. Please try again later.' });
            }

            // Caption
            let caption = `🎵 *TIKTOK DOWNLOADER* 🎵\n\n`;
            caption += `👤 *Author:* ${data.author || 'Unknown'}\n`;
            caption += `📝 *Title:* ${data.caption || 'No Title'}\n`;
            caption += `⚡ *Provider:* ${data.provider}\n`;
            caption += `\n> WASI-MD-V7`;

            // Send Content (Video)
            if (data.video) {
                await wasi_sock.sendMessage(wasi_sender, {
                    video: { url: data.video },
                    caption: caption
                });
            } else {
                await wasi_sock.sendMessage(wasi_sender, { text: '❌ Video URL not found.' });
            }

            // Send Audio if available (optional, but good for users)
            /*
            if (data.audio) {
                await wasi_sock.sendMessage(wasi_sender, {
                    audio: { url: data.audio },
                    mimetype: 'audio/mp4',
                    fileName: 'tiktok.mp3'
                });
            }
            */

        } catch (e) {
            console.error('TikTok Command Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
