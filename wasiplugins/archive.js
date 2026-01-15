module.exports = {
    name: 'archive',
    category: 'Chats',
    desc: 'Archive the current chat',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg } = context;
        await wasi_sock.chatModify(
            {
                archive: true,
                lastMessages: [{ key: wasi_msg.key, messageTimestamp: wasi_msg.messageTimestamp }],
            },
            wasi_sender
        );
        await wasi_sock.sendMessage(wasi_sender, { text: '✅ Chat archived.' });
    }
};
