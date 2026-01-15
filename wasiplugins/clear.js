module.exports = {
    name: 'clear',
    category: 'Chats',
    desc: 'Clear the chat history',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg } = context;
        await wasi_sock.chatModify(
            {
                clear: true,
                lastMessages: [{ key: wasi_msg.key, messageTimestamp: wasi_msg.messageTimestamp }],
            },
            wasi_sender
        );
        await wasi_sock.sendMessage(wasi_sender, { text: '✅ Chat cleared.' });
    }
};
