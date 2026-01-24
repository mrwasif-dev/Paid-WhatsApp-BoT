const { wasi_pinterest_search } = require('../wasilib/scrapers');

module.exports = {
    name: 'pinsearch',
    aliases: ['psearch', 'pintsearch'],
    category: 'Media',
    desc: 'Search for images on Pinterest',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg, wasi_args } = context;
        const query = wasi_args.join(' ');

        if (!query) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please provide a search query.' });

        await wasi_sock.sendMessage(wasi_sender, { text: '🔎 *Searching Pinterest...*' });

        try {
            const data = await wasi_pinterest_search(query);

            if (!data.status || !data.result || data.result.length === 0) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ No results found.' });
            }

            // Send first 5 results as separate messages or one?
            // Usually, pin search sends a few top images.
            // Let's send the first 5.
            const axios = require('axios');
            const limit = Math.min(data.result.length, 5);

            for (let i = 0; i < limit; i++) {
                const imgUrl = data.result[i];
                try {
                    await wasi_sock.sendMessage(wasi_sender, {
                        image: { url: imgUrl },
                        caption: `🖼️ *Pinterest Result ${i + 1}*\n> WASI-MD-V7`
                    }, { quoted: wasi_msg });
                } catch (err) {
                    console.error(`Failed to send image ${i + 1}:`, err.message);
                }
            }

        } catch (e) {
            console.error('[PINSEARCH] Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
