const { wasi_setUserAutoStatus, wasi_getUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'status',
    description: 'Manage Status settings (Auto Seen, Auto React, Auto Save).',
    aliases: ['story'],
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isOwner, wasi_isSudo, sessionId, wasi_sender } = context;

        // Settings are usually per-user (the bot owner mainly, but maybe others if multi-session)
        // Since this is a bot, it applies to how the BOT interacts with OTHERS' statuses.
        // So we apply this to the 'Owner' JID settings in DB, or the caller if valid.

        if (!wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ Only Owner/Sudo can manage Status settings.' });
        }

        const type = wasi_args[0]?.toLowerCase();
        const action = wasi_args[1]?.toLowerCase();

        // Target: modify the BOT's behavior for the owner's account (or whoever the bot is acting as)
        // Database schema 'UserSettings' keyed by JID.
        // We update the settings for the bot's own JID or the Owner's config?
        // Index.js looks up: ` userSettings = await wasi_getUserAutoStatus(sessionId, statusOwner);`
        // Wait, index.js checks settings for the *person posting the status*.
        // `if (wasi_sender === 'status@broadcast') { const statusOwner = wasi_msg.key.participant; ... }`
        // So if I set `autoStatusSeen: true` for `someUser`, the bot will read THEIR status.
        // This allows whitelisting.
        // BUT usually users want "Auto Read ALL Statuses".
        // In `index.js`: `const shouldAutoView = userSettings?.autoStatusSeen || config.autoStatusSeen;`
        // So global config fallback exists.

        // This command should probably toggle the GLOBAL config or the User-Specific config.
        // Let's implement GLOBAL toggle for simplicity via BotConfig, or a "self" setting.

        // Actually, let's stick to what's likely expected: "Bot, read all statuses".
        // For that, we update the Global Bot Config.

        const { wasi_updateBotConfig, wasi_getBotConfig } = require('../wasilib/database');

        if (!['seen', 'react', 'save'].includes(type) || !['on', 'off'].includes(action)) {
            const config = await wasi_getBotConfig(sessionId);
            return await sock.sendMessage(from, {
                text: `⚠️ *Status Settings Manager*\n\n` +
                    `Usage:\n` +
                    `• *.status seen on/off* (Auto View)\n` +
                    `• *.status react on/off* (Auto Like)\n` +
                    `• *.status save on/off* (Auto Forward/Save)\n\n` +
                    `Current Settings:\n` +
                    `👁️ Seen: ${config.autoStatusSeen ? 'ON' : 'OFF'}\n` +
                    `❤️ React: ${config.autoStatusReact ? 'ON' : 'OFF'}\n` +
                    `💾 Save: ${config.autoStatusSave ? 'ON' : 'OFF'}` // autoStatusSave needs to result in index.js logic update if we want it global
            });
        }

        const updates = {};
        if (type === 'seen') updates.autoStatusSeen = (action === 'on');
        if (type === 'react') updates.autoStatusReact = (action === 'on');
        if (type === 'save') updates.autoStatusSave = (action === 'on'); // Ensure schema supports this

        await wasi_updateBotConfig(sessionId, updates);

        return await sock.sendMessage(from, { text: `✅ Status Setting *${type.toUpperCase()}* set to *${action.toUpperCase()}*` });
    }
};
