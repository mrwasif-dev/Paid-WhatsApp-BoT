module.exports = {
    name: 'delete',
    category: 'Chats',
    desc: 'Delete the current chat',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg } = context;
        await wasi_sock.chatModify(
            {
                delete: true,
                lastMessages: [{ key: wasi_msg.key, messageTimestamp: wasi_msg.messageTimestamp }],
            },
            wasi_sender
        );
    }
};
