const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'antilink',
    description: 'Enable or disable Anti-Link for this group.',
    aliases: ['link'],
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId } = context;

        if (!wasi_isGroup) {
            return await sock.sendMessage(from, { text: '❌ This command is only for groups.' });
        }

        if (!wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ You need to be an Admin to use this command.' });
        }

        const action = wasi_args[0]?.toLowerCase();

        if (!['on', 'off'].includes(action)) {
            const current = await wasi_getGroupSettings(sessionId, from);
            const status = current ? (current.antilink ? 'ON' : 'OFF') : 'OFF';
            return await sock.sendMessage(from, { text: `⚠️ Use: *.antilink on* or *.antilink off*\n🛡️ Current Status: *${status}*` });
        }

        const isEnabled = action === 'on';
        await wasi_updateGroupSettings(sessionId, from, { antilink: isEnabled });

        return await sock.sendMessage(from, { text: `🛡️ *Anti-Link* has been turned *${action.toUpperCase()}* for this group.` });
    }
};
