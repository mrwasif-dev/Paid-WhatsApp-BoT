module.exports = {
    name: 'wasilyrics',
    description: 'Find lyrics for any song',
    aliases: ['lyrics', 'lyric'],
    category: 'Search',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args } = context;
        if (!wasi_args.length) {
            return await sock.sendMessage(from, { text: '❌ Usage: .lyrics Song Name' });
        }

        const query = wasi_args.join(' ');
        await sock.sendMessage(from, { text: '🔍 *Searching Lyrics...*' });

        try {
            // Using a reliable lyrics API (Genius or similar, but via a scraping wrapper if needed)
            // Let's use a public API.
            const { wasi_get } = require('../wasilib/fetch');
            const apiUrl = `https://api.vreden.my.id/api/v1/search/lyrics?query=${encodeURIComponent(query)}`;

            const data = await wasi_get(apiUrl);

            if (data && data.result) {
                const { title, artist, lyrics, image } = data.result;

                await sock.sendMessage(from, {
                    image: { url: image || 'https://i.pinimg.com/564x/d5/b6/26/d5b626493633633632363636363636.jpg' },
                    caption: `🎤 *${title} - ${artist}*\n\n${lyrics}\n\n> WASI-MD-V7`
                });
            } else {
                // Fallback
                throw new Error('NotFound');
            }

        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Lyrics not found.' });
        }
    }
};
