const { getMenu } = require('../wasilib/menus');

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

            // Send Message
            const IMAGE_URL = config.menuImage;

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

            try {
                // If there's an image, send as caption
                await wasi_sock.sendMessage(wasi_sender, {
                    image: { url: IMAGE_URL },
                    caption: menuText,
                    contextInfo: contextInfo
                });
            } catch (e) {
                console.error('Menu Image Send Failed:', e.message); // Log the specific error
                // Fallback to text if image fails
                await wasi_sock.sendMessage(wasi_sender, {
                    text: menuText,
                    contextInfo: contextInfo
                });
            }

        } catch (e) {
            console.error('Menu Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to load menu.' });
        }
    }
};
