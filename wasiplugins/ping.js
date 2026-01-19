module.exports = {
    name: 'ping',
    category: 'General',
    desc: 'Check if the bot is alive',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const config = require('../wasi');
        const { wasi_msg } = context;

        const start = Date.now();

        // Calculate latency based on message timestamp if available
        // Note: msg.messageTimestamp is in seconds, convert to ms
        // But for "Processing Speed" we compare current time.

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
            text: 'Pong! 🏓',
            contextInfo: contextInfo
        }).then(async (sentMsg) => {
            const end = Date.now();
            const latency = end - start;
            await wasi_sock.sendMessage(wasi_sender, {
                text: `*Pong!* 🏓\n*Latency:* ${latency}ms`,
                edit: sentMsg.key
            });
        });
    }
};
