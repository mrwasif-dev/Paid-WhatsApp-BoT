module.exports = {
    name: 'ping',
    category: 'General',
    desc: 'Check if the bot is alive',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        await wasi_sock.sendMessage(wasi_sender, { text: 'Wasi Bot: Pong!' });
    }
};
