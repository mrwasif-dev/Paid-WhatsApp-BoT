module.exports = {
    name: 'wasitts',
    description: 'Text to Speech generator',
    aliases: ['tts', 'voice', 'speak'],
    category: 'Fun',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args } = context;
        if (!wasi_args.length) {
            return await sock.sendMessage(from, { text: '❌ Usage: .tts Hello World' });
        }

        const text = wasi_args.join(' ');
        // Google TTS API (Unofficial but reliable for simple use)
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;

        await sock.sendMessage(from, {
            audio: { url: url },
            mimetype: 'audio/mp4',
            ptt: true // Send as voice note
        });
    }
};
