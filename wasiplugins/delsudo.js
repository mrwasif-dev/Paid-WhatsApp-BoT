const { wasi_updateBotConfig } = require('../wasilib/database');

module.exports = {
    name: 'delsudo',
    aliases: ['rmsudo', 'removesudo'],
    category: 'Owner',
    desc: 'Remove a user from Sudo.',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, wasi_msg, sessionId, config } = context;

        // Get user to remove
        let userToRemove = '';
        if (wasi_msg.message.extendedTextMessage?.contextInfo?.participant) {
            userToRemove = wasi_msg.message.extendedTextMessage.contextInfo.participant;
        } else if (wasi_args.length > 0) {
            userToRemove = wasi_args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }

        if (!userToRemove) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please mention a user or provide their number.' });
        }

        // Filter out
        const currentSudo = config.sudo || [];
        const newSudo = currentSudo.filter(id => id !== userToRemove);

        if (currentSudo.length === newSudo.length) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '⚠️ This user is NOT in the Sudo list.' });
        }

        // Update DB
        await wasi_updateBotConfig(sessionId, { sudo: newSudo });
        config.sudo = newSudo;

        await wasi_sock.sendMessage(wasi_sender, {
            text: `✅ *User Removed from Sudo!* \n\n👤 *User:* @${userToRemove.split('@')[0]}`,
            mentions: [userToRemove]
        });
    }
};
