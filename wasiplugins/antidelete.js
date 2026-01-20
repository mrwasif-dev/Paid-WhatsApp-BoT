const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'antidelete',
    description: 'Enable or disable Anti-Delete for this group.',
    aliases: ['anticall'], // optional alias? maybe 'antidel'
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId } = context;

        if (!wasi_isGroup) {
            // Anti-delete can work in private chats too, but let's restrict to groups for now or check args
            // Usually requested for groups.
            // Let's support both if user wants? But logic in index.js checks 'groupSettings'.
            // For PMs we would need 'userSettings' or handle it differently.
            // Index.js implementation uses 'wasi_getGroupSettings' which keys by JID.
            // So it CAN work for PMs if we allow it here.
        }

        if (wasi_isGroup && !wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ You need to be an Admin to use this command.' });
        }

        const action = wasi_args[0]?.toLowerCase();

        if (!['on', 'off'].includes(action)) {
            const current = await wasi_getGroupSettings(sessionId, from);
            const status = current ? (current.antidelete ? 'ON' : 'OFF') : 'OFF';
            return await sock.sendMessage(from, { text: `⚠️ Use: *.antidelete on* or *.antidelete off*\n🗑️ Current Status: *${status}*` });
        }

        const isEnabled = action === 'on';
        await wasi_updateGroupSettings(sessionId, from, { antidelete: isEnabled });

        return await sock.sendMessage(from, { text: `🗑️ *Anti-Delete* has been turned *${action.toUpperCase()}* for this chat.` });
    }
};
