module.exports = {
    name: 'alive',
    category: 'General',
    desc: 'Check if the bot is operational',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        const os = require('os');
        const config = require('../wasi');

        // Uptime Calculation
        const wasi_uptime = process.uptime();
        const wasi_hours = Math.floor(wasi_uptime / 3600);
        const wasi_minutes = Math.floor((wasi_uptime % 3600) / 60);
        const wasi_seconds = Math.floor(wasi_uptime % 60);

        // System Info
        const ramTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); // GB
        const ramFree = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);   // GB
        const platform = os.platform(); // win32, linux
        const hostname = os.hostname();

        const wasi_status = `*⚡ WASI-MD-V7 IS ONLINE ⚡*\n\n` +
            `👤 *User:* @${wasi_sender.split('@')[0]}\n` +
            `🖥️ *Platform:* ${platform.toUpperCase()}\n` +
            `💾 *RAM:* ${ramFree}GB / ${ramTotal}GB\n` +
            `⌚ *Uptime:* ${wasi_hours}h ${wasi_minutes}m ${wasi_seconds}s\n` +
            `🚀 *Speed:* Fast & Reliable\n` +
            `👑 *Owner:* ${config.ownerName}\n\n` +
            `> _WASI-MD-V7 · The Advanced Bot_`;

        const contextInfo = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.newsletterJid || '120363419652241844@newsletter',
                newsletterName: config.newsletterName || 'WASI-MD-V7',
                serverMessageId: -1
            }
        };

        const imageUrl = config.menuImage && config.menuImage.startsWith('http') ? config.menuImage : 'https://i.ibb.co/31z1z8d/invite.png';

        try {
            await wasi_sock.sendMessage(wasi_sender, {
                image: { url: imageUrl },
                caption: wasi_status,
                mentions: [wasi_sender],
                contextInfo: contextInfo
            });
        } catch (e) {
            console.error('Alive Image Error:', e);
            // Fallback to text if image fails
            await wasi_sock.sendMessage(wasi_sender, {
                text: wasi_status,
                mentions: [wasi_sender],
                contextInfo: contextInfo
            });
        }
    }
};
