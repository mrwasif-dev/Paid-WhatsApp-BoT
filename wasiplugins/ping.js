module.exports = {
    name: 'ping',
    category: 'General',
    desc: 'Check if the bot is alive',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        const config = require('../wasi');
        const contextInfo = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.newsletterJid || '120363419652241844@newsletter',
                newsletterName: config.newsletterName || 'WASI-MD-V7',
                serverMessageId: -1
            }
        };
        await wasi_sock.sendMessage(wasi_sender, {
            text: 'Wasi Bot: Pong!',
            contextInfo: contextInfo
        });
    }
};
