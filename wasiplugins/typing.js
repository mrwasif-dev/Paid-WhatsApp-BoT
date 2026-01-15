const { wasi_isDbConnected, wasi_getUserAutoStatus, wasi_setUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'typing',
    aliases: ['autotyping'],
    category: 'Settings',
    desc: 'Toggle auto typing indicator',
    ownerOnly: true, // Only owner can use this command
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args } = context;

        if (!wasi_isDbConnected()) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ Database is not connected. This feature requires MongoDB.'
            });
        }

        const currentSettings = await wasi_getUserAutoStatus(wasi_sender);
        const isCurrentlyEnabled = currentSettings?.autoTyping || false;

        const arg = wasi_args?.toLowerCase()?.trim();

        if (arg === 'on' || arg === 'enable') {
            await wasi_setUserAutoStatus(wasi_sender, { autoTyping: true, autoRecording: false });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '✅ *Auto Typing Enabled!*\n\n⌨️ Bot will show "typing..." before responding to you.'
            });
        }

        if (arg === 'off' || arg === 'disable') {
            await wasi_setUserAutoStatus(wasi_sender, { autoTyping: false });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Auto Typing Disabled!*'
            });
        }

        const statusText = isCurrentlyEnabled ? '🟢 ON' : '🔴 OFF';
        return wasi_sock.sendMessage(wasi_sender, {
            text: `⌨️ *Auto Typing Settings*\n\nCurrent Status: ${statusText}\n\n*Usage:*\n• \`.typing on\` - Enable\n• \`.typing off\` - Disable`
        });
    }
};
