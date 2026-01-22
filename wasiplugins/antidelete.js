const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'antidelete',
    description: 'Advanced Anti-Delete system - recover deleted messages',
    aliases: ['antidel', 'recover'],
    category: 'Group',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId, wasi_msg } = context;

        // Allow in both groups and PMs (for personal anti-delete)
        if (wasi_isGroup && !wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ You need to be an Admin to use this command.' });
        }

        const action = wasi_args[0]?.toLowerCase();
        const current = await wasi_getGroupSettings(sessionId, from) || {};

        // Show status if no args
        if (!action) {
            const status = current.antidelete ? '🟢 ON' : '🔴 OFF';
            const destination = current.antideleteDestination || 'group';

            let text = `🗑️ *ANTI-DELETE SETTINGS*\n\n`;
            text += `📌 *Status:* ${status}\n`;
            text += `📍 *Destination:* ${destination}\n\n`;
            text += `*Available Commands:*\n`;
            text += `• \`.antidelete on\` - Enable\n`;
            text += `• \`.antidelete off\` - Disable\n`;
            text += `• \`.antidelete group\` - Send recovered messages to group\n`;
            text += `• \`.antidelete owner\` - Send recovered messages to owner only\n`;
            text += `• \`.antidelete both\` - Send to both group and owner\n\n`;
            text += `_When enabled, deleted messages will be recovered and shown._`;

            return await sock.sendMessage(from, { text });
        }

        // On/Off
        if (action === 'on') {
            await wasi_updateGroupSettings(sessionId, from, { antidelete: true });
            return await sock.sendMessage(from, { text: `🗑️ *Anti-Delete* has been *ENABLED*.\n\nDeleted messages will be recovered.` });
        }

        if (action === 'off') {
            await wasi_updateGroupSettings(sessionId, from, { antidelete: false });
            return await sock.sendMessage(from, { text: `🗑️ *Anti-Delete* has been *DISABLED*.` });
        }

        // Destination settings
        if (action === 'group' || action === 'chat') {
            await wasi_updateGroupSettings(sessionId, from, { antideleteDestination: 'group' });
            return await sock.sendMessage(from, { text: `📍 Anti-Delete destination set to *GROUP*.\n\nRecovered messages will be sent to this chat.` });
        }

        if (action === 'owner' || action === 'dm' || action === 'private') {
            await wasi_updateGroupSettings(sessionId, from, { antideleteDestination: 'owner' });
            return await sock.sendMessage(from, { text: `📍 Anti-Delete destination set to *OWNER*.\n\nRecovered messages will be sent to the bot owner privately.` });
        }

        if (action === 'both' || action === 'all') {
            await wasi_updateGroupSettings(sessionId, from, { antideleteDestination: 'both' });
            return await sock.sendMessage(from, { text: `📍 Anti-Delete destination set to *BOTH*.\n\nRecovered messages will be sent to both group and owner.` });
        }

        // Unknown action
        return await sock.sendMessage(from, { text: `❌ Unknown action. Use \`.antidelete\` to see available options.` });
    }
};
