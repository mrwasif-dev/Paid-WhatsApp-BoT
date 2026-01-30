module.exports = {
    name: 'owner',
    category: 'Info',
    desc: 'Shows the bot owner Telegram contact with a clickable button',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            const ownerTelegram = 'https://t.me/paid_whatsapp_bot';

            // Prepare the message
            const message = {
                text: 'Click the button below to open Telegram', // اوپر والا text
                footer: '🤖 Contact Owner', // button کے اوپر text
                templateButtons: [
                    {
                        index: 1,
                        urlButton: {
                            displayText: '🤖 Contact Owner',
                            url: ownerTelegram
                        }
                    }
                ]
            };

            // Send the message
            await wasi_sock.sendMessage(wasi_sender, message);

        } catch (error) {
            console.error(error);
            await wasi_sock.sendMessage(wasi_sender, { text: 'Error fetching owner info.' });
        }
    }
};
