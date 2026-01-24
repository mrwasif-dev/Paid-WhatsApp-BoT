const { wasi_pinterest } = require('../wasilib/scrapers');

module.exports = {
    name: 'pinterest',
    aliases: ['pin', 'pindl'],
    category: 'Downloader',
    desc: 'Download Pinterest Images and Videos',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args } = context;

        let url = wasi_args[0];

        // Ensure URL is present
        if (!url) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please provide a Pinterest URL.\n\nUsage: .pinterest https://pin.it/...' });
        }

        // Validate URL
        if (!url.includes('pin.it') && !url.includes('pinterest.com')) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Invalid Pinterest URL.' });
        }

        await wasi_sock.sendMessage(wasi_sender, { text: '⏳ *Fetching Pinterest media...*' });

        try {
            const data = await wasi_pinterest(url);

            if (!data.status || !data.url) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to download media. Please try again later.' });
            }

            // Caption
            let caption = `📌 *PINTEREST DOWNLOADER* 📌\n\n`;
            if (data.title) caption += `📝 *Title:* ${data.title}\n`;
            caption += `⚡ *Provider:* ${data.provider}\n`;
            caption += `\n> WASI-MD-V7`;

            const axios = require('axios');
            try {
                const response = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 30000 });
                const buffer = Buffer.from(response.data);

                if (data.type === 'video') {
                    await wasi_sock.sendMessage(wasi_sender, {
                        video: buffer,
                        caption: caption
                    });
                } else {
                    await wasi_sock.sendMessage(wasi_sender, {
                        image: buffer,
                        caption: caption
                    });
                }
            } catch (ferr) {
                console.error(`Media Fetch Failed (${data.url}):`, ferr.message);
                await wasi_sock.sendMessage(wasi_sender, { text: `❌ Failed to fetch media from the source URL.` });
            }

        } catch (e) {
            console.error('Pinterest Command Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
