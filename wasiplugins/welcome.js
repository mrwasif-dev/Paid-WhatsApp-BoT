const { wasi_updateBotConfig } = require('../wasilib/database');

module.exports = {
    name: 'welcome',
    aliases: ['wellcome'],
    category: 'Group',
    desc: 'Enable/Disable or set custom Welcome message.\nUsage:\n.welcome on/off\n.welcome <message>',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, sessionId, config, wasi_msg } = context;

        if (wasi_args.length === 0) {
            return await wasi_sock.sendMessage(wasi_sender, {
                text: `👋 *Welcome Manager*\n\n*Status:* ${config.autoWelcome ? 'Enabled ✅' : 'Disabled ❌'}\n*Current Message:* ${config.welcomeMessage}\n\n*Usage:*\n- .welcome on\n- .welcome off\n- .welcome <your message>\n\n*Tags:* @user, @group`
            }, { quoted: wasi_msg });
        }

        const input = wasi_args[0].toLowerCase();
        let updateObj = {};
        let responseText = '';

        if (input === 'on') {
            updateObj = { autoWelcome: true };
            responseText = '✅ Auto Welcome enabled.';
        } else if (input === 'off') {
            updateObj = { autoWelcome: false };
            responseText = '❌ Auto Welcome disabled.';
        } else {
            // Treat as custom message
            const customMsg = wasi_args.join(' ');
            updateObj = { welcomeMessage: customMsg, autoWelcome: true };
            responseText = `✅ Welcome message updated and enabled:\n\n"${customMsg}"`;
        }

        const success = await wasi_updateBotConfig(sessionId, updateObj);
        if (success) {
            Object.assign(config, updateObj);
            await wasi_sock.sendMessage(wasi_sender, { text: responseText }, { quoted: wasi_msg });
        } else {
            await wasi_sock.sendMessage(wasi_sender, { text: '❌ Database Error.' }, { quoted: wasi_msg });
        }
    }
};
