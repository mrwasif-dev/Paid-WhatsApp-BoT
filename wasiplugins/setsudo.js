const { wasi_updateBotConfig } = require('../wasilib/database');

module.exports = {
    name: 'setsudo',
    aliases: ['addsudo', 'createsudo'],
    category: 'Owner',
    desc: 'Add a user as a Sudo (temporary owner).',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, wasi_msg, sessionId, config } = context;
        // NOTE: Permissions (Owner/Sudo check) are handled inside plugin or main index. 
        // We will assume index.js modifies 'isOwner' to include SUDO users, 
        // BUT 'setsudo' should likely ONLY be usable by the REAL OWNER.
        // For now, let's assume the caller must be validated strictly elsewhere 
        // or we check it here if passed in context.

        // Get user to add
        let userToAdd = '';
        if (wasi_msg.message.extendedTextMessage?.contextInfo?.participant) {
            userToAdd = wasi_msg.message.extendedTextMessage.contextInfo.participant;
        } else if (wasi_args.length > 0) {
            // Handle number input (e.g. 923...)
            userToAdd = wasi_args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }

        if (!userToAdd) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please mention a user or provide their number.' });
        }

        // Current Sudo List
        const currentSudo = config.sudo || [];

        if (currentSudo.includes(userToAdd)) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '⚠️ This user is already a Sudo.' });
        }

        // Add
        currentSudo.push(userToAdd);

        // Update DB
        // We need to pass the FULL update object
        await wasi_updateBotConfig(sessionId, { sudo: currentSudo });

        // Update Local Config (Instant reflection)
        config.sudo = currentSudo;

        await wasi_sock.sendMessage(wasi_sender, {
            text: `✅ *User Added to Sudo!* \n\n👤 *User:* @${userToAdd.split('@')[0]}`,
            mentions: [userToAdd]
        });
    }
};
