module.exports = {
    name: 'unstar',
    category: 'Chats',
    desc: 'Unstar a message',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg } = context;
        if (!wasi_msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
            return wasi_sock.sendMessage(wasi_sender, { text: '❌ Please reply to a message to unstar it.' });
        }

        const quotedId = wasi_msg.message.extendedTextMessage.contextInfo.stanzaId;
        const quotedParticipant = wasi_msg.message.extendedTextMessage.contextInfo.participant || wasi_sender;

        await wasi_sock.chatModify(
            {
                star: {
                    messages: [{ id: quotedId, fromMe: quotedParticipant === wasi_sock.user.id, remoteJid: wasi_sender }],
                    star: false
                }
            },
            wasi_sender
        );
        await wasi_sock.sendMessage(wasi_sender, { text: '⭐ Message unstarred.' });
    }
};
