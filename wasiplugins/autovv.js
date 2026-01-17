const { wasi_setUserAutoStatus, wasi_getUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'autovv',
    category: 'Settings',
    desc: 'Toggle Auto View Once Conversion on/off',
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_args }) => {
        try {
            // This setting should ideally be per-chat or global?
            // User requested "in chats", so we can make it a setting for the *sender* (admin) to enable for the bot to do it in that chat...
            // OR checks if the bot should do it globally.

            // For now, let's implement it as a per-user setting (since we have wasi_userSettingsSchema).
            // This means "if I turn it on, any view once message sent TO ME (or in a group I'm in?) will be converted".

            // Actually, we can just use the existing UserSettings schema and add a new field if possible, or repurpose a general "settings" map.
            // Since updating schema requires migration/restart which is complex autonomously, 
            // I'll check if I can add a new schema or just use a new collection easily.
            // `database.js` defines schema. I should add `autoViewOnce` to `wasi_userSettingsSchema`.

            // Wait, I can't easily edit the running Mongoose schema without restarting the app properly. 
            // I will edit `database.js` to add `autoViewOnce` to the schema first.

            const status = wasi_args.toLowerCase() === 'on';
            if (wasi_args.toLowerCase() !== 'on' && wasi_args.toLowerCase() !== 'off') {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage: .autovv on/off' });
            }

            // Get current settings
            let settings = await wasi_getUserAutoStatus(wasi_sender) || {};

            // Update
            settings.autoViewOnce = status;

            // Save
            await wasi_setUserAutoStatus(wasi_sender, settings);

            await wasi_sock.sendMessage(wasi_sender, { text: `✅ Auto View Once has been turned *${status ? 'ON' : 'OFF'}* for you.` });

        } catch (e) {
            console.error('AutoVV Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
