const { getMenu } = require('../wasilib/menus');
const { getRandomMenuAsset, hasMenuAssets } = require('../wasilib/assets');

module.exports = {
    name: 'menu',
    aliases: ['help', 'commands', 'list'],
    category: 'General',
    desc: 'Show all available commands',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_plugins, wasi_msg } = context;
        const config = require('../wasi');

        try {
            // Get user name
            const userName = wasi_msg.pushName || 'User';

            // Generate menu text using the selected style
            const styles = config.menuStyle || 'classic';
            const menuText = getMenu(wasi_plugins, userName, styles);

            // Context Info for View Channel
            const contextInfo = {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.newsletterJid || '120363419652241844@newsletter',
                    newsletterName: config.newsletterName || 'WASI-MD-V7',
                    serverMessageId: -1
                }
            };

            // PRIORITY 1: Try local assets folder first
            if (config.menuImageAsset && hasMenuAssets()) {
                const asset = getRandomMenuAsset();
                if (asset) {
                    console.log(`📁 Using local menu asset: ${asset.filename}`);

                    if (asset.type === 'image') {
                        return await wasi_sock.sendMessage(wasi_sender, {
                            image: asset.buffer,
                            caption: menuText,
                            contextInfo: contextInfo
                        });
                    } else if (asset.type === 'video') {
                        return await wasi_sock.sendMessage(wasi_sender, {
                            video: asset.buffer,
                            caption: menuText,
                            gifPlayback: false,
                            contextInfo: contextInfo
                        });
                    }
                }
            }

            // PRIORITY 2: Use URL
            if (config.menuImageUrl || !config.menuImageAsset) {
                const IMAGE_URL = config.menuImage;

                try {
                    const axios = require('axios');
                    const response = await axios.get(IMAGE_URL, { responseType: 'arraybuffer', timeout: 8000 });
                    const buffer = Buffer.from(response.data);

                    // Detect if it's a video by content type or URL
                    const contentType = response.headers['content-type'] || '';
                    const isVideo = contentType.includes('video') ||
                        IMAGE_URL.match(/\.(mp4|mkv|webm)$/i);

                    if (isVideo) {
                        return await wasi_sock.sendMessage(wasi_sender, {
                            video: buffer,
                            caption: menuText,
                            gifPlayback: false,
                            contextInfo: contextInfo
                        });
                    } else {
                        return await wasi_sock.sendMessage(wasi_sender, {
                            image: buffer,
                            caption: menuText,
                            contextInfo: contextInfo
                        });
                    }
                } catch (e) {
                    console.error(`Menu Image Fetch Failed (${IMAGE_URL}):`, e.message);
                }
            }

            // FALLBACK: Text only
            await wasi_sock.sendMessage(wasi_sender, {
                text: menuText,
                contextInfo: contextInfo
            });

        } catch (e) {
            console.error('Menu Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to load menu.' });
        }
    }
};
