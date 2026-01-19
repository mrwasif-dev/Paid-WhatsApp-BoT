const { wasi_setUserAutoStatus, wasi_getUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'autovv',
    category: 'Settings',
    desc: 'Toggle Auto View Once Conversion on/off',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, sessionId } = context;

        try {
            if (!wasi_args || wasi_args.length === 0) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage: .autovv on/off' });
            }

            const input = wasi_args[0].toLowerCase();
            const status = input === 'on';

            if (input !== 'on' && input !== 'off') {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage: .autovv on/off' });
            }

            // Get current settings using correct arguments (sessionId, jid)
            const { wasi_getUserAutoStatus, wasi_setUserAutoStatus } = require('../wasilib/database');
            let settings = await wasi_getUserAutoStatus(sessionId, wasi_sender) || {};

            // Update
            settings.jid = wasi_sender; // Ensure JID is set
            settings.autoViewOnce = status;

            // Save
            await wasi_setUserAutoStatus(sessionId, wasi_sender, settings);

            await wasi_sock.sendMessage(wasi_sender, { text: `✅ Auto View Once has been turned *${status ? 'ON' : 'OFF'}* for you.` });

        } catch (e) {
            console.error('AutoVV Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
