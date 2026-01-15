module.exports = {
    name: 'add',
    category: 'Group',
    desc: 'Add a user to the group',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args, wasi_msg } = context;
        if (!wasi_sender.endsWith('@g.us')) return wasi_sock.sendMessage(wasi_sender, { text: '❌ This command only works in groups.' });

        let wasi_user = wasi_args.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        if (wasi_msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) {
            wasi_user = wasi_msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        }

        if (!wasi_args && !wasi_msg.message.extendedTextMessage?.contextInfo?.mentionedJid) {
            return wasi_sock.sendMessage(wasi_sender, { text: '❓ Please tag a user or provide a number.' });
        }

        try {
            await wasi_sock.groupParticipantsUpdate(wasi_sender, [wasi_user], "add");
            await wasi_sock.sendMessage(wasi_sender, { text: `✅ User added successfully.` });
        } catch (e) {
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Failed to add user. Ensure I am an admin.` });
        }
    }
};
