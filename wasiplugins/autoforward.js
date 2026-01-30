const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'autoforward',
    description: 'Auto-forward messages from multiple Source JIDs to Target JIDs (works in any chat)',
    aliases: ['af', 'autof'],
    category: 'Utilities',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, sessionId } = context;

        if (!wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '🙅‍♂️ You need admin/owner privileges to configure Auto-Forward.' });
        }

        const action = wasi_args[0]?.toLowerCase();
        const current = await wasi_getGroupSettings(sessionId, from) || {};

        if (!action) {
            let text = `📡 *AUTO-FORWARD SETUP*\n\n`;
            text += `💡 Configure multiple Source and Target JIDs.\n\n`;
            text += `🔧 *Commands:*\n`;
            text += `• \`.autoforward on\` - Enable Auto-Forward\n`;
            text += `• \`.autoforward off\` - Disable Auto-Forward\n`;
            text += `• \`.autoforward set <sourceJIDs> = <targetJIDs>\` - Set sources and targets (comma-separated)\n`;
            text += `• \`.autoforward clear\` - Clear all sources and targets\n\n`;
            text += `💡 Example:\n`;
            text += `\`.autoforward set 12345@s.whatsapp.net,67890@s.whatsapp.net = 11111@s.whatsapp.net,22222@s.whatsapp.net\``;

            return await sock.sendMessage(from, { text });
        }

        if (action === 'on') {
            if (!current.sourceJIDs || current.sourceJIDs.length === 0 || !current.autoForwardTargets || current.autoForwardTargets.length === 0) {
                return await sock.sendMessage(from, { text: '⚠️ Please configure Source and Target JIDs first using `.autoforward set <sourceJIDs> = <targetJIDs>`' });
            }
            await wasi_updateGroupSettings(sessionId, from, { autoForward: true });
            return await sock.sendMessage(from, { text: '✅ Auto-Forward is now *enabled*.' });
        }

        if (action === 'off') {
            await wasi_updateGroupSettings(sessionId, from, { autoForward: false });
            return await sock.sendMessage(from, { text: '🛑 Auto-Forward has been *disabled*.' });
        }

        if (action === 'set') {
            const input = wasi_args.slice(1).join(' ').trim();

            if (!input.includes('=')) {
                return await sock.sendMessage(from, { text: '❌ Invalid format! Use: `.autoforward set <sourceJIDs> = <targetJIDs>`' });
            }

            const [sourcesPart, targetsPart] = input.split('=').map(s => s.trim());

            // Format Source JIDs
            const sources = sourcesPart.split(',').map(j => {
                let jid = j.trim();
                if (jid && !jid.includes('@')) jid += '@s.whatsapp.net';
                return jid;
            }).filter(j => j.length > 5);

            // Format Target JIDs
            const targets = targetsPart.split(',').map(j => {
                let jid = j.trim();
                if (jid && !jid.includes('@')) jid += '@s.whatsapp.net';
                return jid;
            }).filter(j => j.length > 5);

            await wasi_updateGroupSettings(sessionId, from, {
                sourceJIDs: sources,
                autoForwardTargets: targets
            });

            return await sock.sendMessage(from, { text: `🎯 Sources: ${sources.join(', ')}\n✅ Targets: ${targets.join(', ')}` });
        }

        if (action === 'clear') {
            await wasi_updateGroupSettings(sessionId, from, { sourceJIDs: [], autoForwardTargets: [], autoForward: false });
            return await sock.sendMessage(from, { text: '🧹 All Source and Target JIDs cleared. Auto-Forward disabled.' });
        }

        return await sock.sendMessage(from, { text: '❌ Unknown action. Use `.autoforward` for help.' });
    }
};
