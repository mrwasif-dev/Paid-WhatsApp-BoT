module.exports = {
    name: 'owner',
    category: 'Info',
    desc: 'Owner & Group links (channel-style URL buttons)',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            await wasi_sock.sendMessage(wasi_sender, {
                text: 'Click the button below to open Telegram',
                templateButtons: [
                    {
                        index: 1,
                        urlButton: {
                            displayText: '🤖 Owner Button',
                            url: 'https://t.me/paid_whatsapp_bot'
                        }
                    },
                    {
                        index: 2,
                        urlButton: {
                            displayText: '👥 Group Join',
                            url: 'https://chat.whatsapp.com/HtYBIWOz11X61yrjcdqRI4?mode=gi_t'
                        }
                    }
                ]
            });
        } catch (error) {
            console.error(error);
            await wasi_sock.sendMessage(wasi_sender, {
                text: 'Failed to load owner info.'
            });
        }
    }
};
