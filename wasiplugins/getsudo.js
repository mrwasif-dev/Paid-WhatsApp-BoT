module.exports = {
    name: 'getsudo',
    aliases: ['listsudo', 'sudolist'],
    category: 'Owner',
    desc: 'View all Sudo users.',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { config } = context;

        const sudoList = config.sudo || [];

        if (sudoList.length === 0) {
            return await wasi_sock.sendMessage(wasi_sender, { text: 'ℹ️ No Sudo users found.' });
        }

        let text = `👑 *SUDO USERS LIST* 👑\n\n`;
        sudoList.forEach((id, index) => {
            text += `${index + 1}. @${id.split('@')[0]}\n`;
        });

        await wasi_sock.sendMessage(wasi_sender, {
            text: text,
            mentions: sudoList
        });
    }
};
