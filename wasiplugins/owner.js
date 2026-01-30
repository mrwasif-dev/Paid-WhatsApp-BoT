module.exports = {
    name: 'owner',
    category: 'Info',
    desc: 'Shows detailed owner info in multiple messages',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            // Array of messages in order
            const messages = [
                '📇 OWNER INFORMATION',
                '👤 Name : Hidden 😛',
                '📍 Location : Pakistan',
                '💼 Role : Bot Developer & Tech Support',
                '🌐 Services\n\n• WhatsApp Bots\n• Telegram Bots\n• Smart Automation',
                '📇 CONTACT INFORMATION',
                '📧 Email : paidwhatsappbot.com',
                '💬 Telegram\n🔗 https://t.me/paid_whatsapp_bot',
                '📱 WhatsApp Contact\n🔗 https://whatsapp.com/channel/0029Vasn4ipCBtxCxfJqgV3S'
            ];

            // Send messages one by one with 0.5 second delay
            for (let msg of messages) {
                await wasi_sock.sendMessage(wasi_sender, { text: msg });
                await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
            }

        } catch (error) {
            console.error(error);
            await wasi_sock.sendMessage(wasi_sender, { text: 'Failed to send owner info.' });
        }
    }
};
