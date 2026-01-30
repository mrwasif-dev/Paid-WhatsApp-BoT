module.exports = {
    name: 'owner',
    category: 'Info',
    desc: 'Shows the bot owner Telegram contact',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            const ownerLink = 'https://t.me/paid_whatsapp_bot';

            // Send simple message with Telegram link
            await wasi_sock.sendMessage(wasi_sender, {
                text: `🤖 Contact the Bot Owner on Telegram:\n${ownerLink}`
            });

        } catch (error) {
            console.error(error);
            await wasi_sock.sendMessage(wasi_sender, { text: 'Error fetching owner info.' });
        }
    }
};
