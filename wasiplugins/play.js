// Play command: fetch YouTube audio and send it
// ---------------------------------------------------
// Usage: .play <search query>
// The command searches YouTube, picks the first result, downloads the audio stream,
// and sends it as an audio message to the chat where the command was issued.
// This plugin is loaded automatically by the bot's plugin loader.

module.exports = {
    name: 'play',
    aliases: [],
    category: 'Media',
    desc: 'Play audio from YouTube (search query)',
    wasi_handler: async (wasi_sock, wasi_origin, context) => {
        const { wasi_msg, wasi_args } = context;
        // Simple permission: allow everyone to use the command
        if (!wasi_args || wasi_args.length === 0) {
            return await wasi_sock.sendMessage(wasi_origin, {
                text: '❌ Usage: .play <search query>'
            }, { quoted: wasi_msg });
        }
        const query = wasi_args.join(' ');
        try {
            // Dynamically require heavy dependencies only when needed
            const ytSearch = require('yt-search');
            const youtubedl = require('youtube-dl-exec');
            const axios = require('axios');

            // Search YouTube for the query
            const searchResult = await ytSearch(query);
            if (!searchResult?.videos?.length) {
                throw new Error('No results found on YouTube');
            }
            const video = searchResult.videos[0];

            // Use youtube-dl-exec to get direct audio URL (best audio)
            const info = await youtubedl(video.url, {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                format: 'bestaudio[ext=m4a]/bestaudio'
            });
            const audioUrl = info.url || (info.formats && info.formats.find(f => f.acodec !== 'none')?.url);
            if (!audioUrl) {
                throw new Error('Unable to obtain audio URL');
            }

            // Download audio into buffer (limit size for safety)
            const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            // Send the audio as a voice note (ptt: false)
            await wasi_sock.sendMessage(wasi_origin, {
                audio: buffer,
                mimetype: info.ext ? `audio/${info.ext}` : 'audio/mpeg',
                ptt: false,
                caption: `▶️ Playing: ${video.title}`
            }, { quoted: wasi_msg });
        } catch (err) {
            console.error('Play command error:', err);
            await wasi_sock.sendMessage(wasi_origin, {
                text: `❌ Failed to play audio: ${err.message}`
            }, { quoted: wasi_msg });
        }
    }
};
