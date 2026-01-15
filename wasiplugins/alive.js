module.exports = {
    name: 'alive',
    category: 'General',
    desc: 'Check if the bot is operational',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        const wasi_uptime = process.uptime();
        const wasi_hours = Math.floor(wasi_uptime / 3600);
        const wasi_minutes = Math.floor((wasi_uptime % 3600) / 60);
        const wasi_seconds = Math.floor(wasi_uptime % 60);

        const wasi_status = `🟢 *WASI BOT IS ALIVE*\n\n` +
            `*Uptime:* ${wasi_hours}h ${wasi_minutes}m ${wasi_seconds}s\n` +
            `*Status:* Operational\n` +
            `*User:* @${wasi_sender.split('@')[0]}`;

        await wasi_sock.sendMessage(wasi_sender, {
            text: wasi_status,
            mentions: [wasi_sender]
        });
    }
};
