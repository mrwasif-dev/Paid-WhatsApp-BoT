const { wasi_isDbConnected, wasi_getUserAutoStatus, wasi_setUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'recording',
    aliases: ['autorecording', 'rec'],
    category: 'Settings',
    desc: 'Toggle auto recording indicator',
    ownerOnly: true, // Only owner can use this command
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, sessionId } = context;

        if (!wasi_isDbConnected()) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ Database is not connected. This feature requires MongoDB.'
            });
        }

        const currentSettings = await wasi_getUserAutoStatus(sessionId, wasi_sender);
        const isCurrentlyEnabled = currentSettings?.autoRecording || false;

        const arg = wasi_args[0]?.toLowerCase()?.trim();

        if (arg === 'on' || arg === 'enable') {
            await wasi_setUserAutoStatus(sessionId, wasi_sender, { autoRecording: true, autoTyping: false });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '✅ *Auto Recording Enabled!*\n\n🎤 Bot will show "recording audio..." before responding to you.'
            });
        }

        if (arg === 'off' || arg === 'disable') {
            await wasi_setUserAutoStatus(sessionId, wasi_sender, { autoRecording: false });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Auto Recording Disabled!*'
            });
        }

        const statusText = isCurrentlyEnabled ? '🟢 ON' : '🔴 OFF';
        return wasi_sock.sendMessage(wasi_sender, {
            text: `🎤 *Auto Recording Settings*\n\nCurrent Status: ${statusText}\n\n*Usage:*\n• \`.recording on\` - Enable\n• \`.recording off\` - Disable`
        });
    }
};
