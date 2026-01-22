const { wasi_toggleCommand, wasi_isDbConnected } = require('../wasilib/database');

module.exports = {
    name: 'toggle',
    category: 'Admin',
    desc: 'Enable or disable a command in this chat',
    ownerOnly: true, // Only owner can use this command
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, wasi_plugins } = context;

        if (!wasi_isDbConnected()) {
            return wasi_sock.sendMessage(wasi_sender, { text: '❌ Database is not connected.' });
        }

        if (!wasi_args) {
            return wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage: .toggle <command> on/off' });
        }

        const [cmd, status] = wasi_args;

        if (!wasi_plugins.has(cmd)) {
            return wasi_sock.sendMessage(wasi_sender, { text: `❌ Command ${cmd} does not exist.` });
        }

        if (cmd === 'toggle') {
            return wasi_sock.sendMessage(wasi_sender, { text: `❌ You cannot toggle the toggle command.` });
        }

        let isEnabled;
        if (status === 'on' || status === 'enable') isEnabled = true;
        else if (status === 'off' || status === 'disable') isEnabled = false;
        else return wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage: .toggle <command> on/off' });

        const success = await wasi_toggleCommand(wasi_sender, cmd, isEnabled);

        if (success) {
            await wasi_sock.sendMessage(wasi_sender, { text: `✅ Command *${cmd}* has been ${isEnabled ? 'enabled' : 'disabled'} in this chat.` });
        } else {
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Database is not connected or error occurred.` });
        }
    }
};
