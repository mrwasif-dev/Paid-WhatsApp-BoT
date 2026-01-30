module.exports = {
    name: 'owner',
    category: 'Info',
    desc: 'Shows owner info in multiple messages to avoid forwarded style',
    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            const messages = [
                '📇 CONTACT INFORMATION',
                '👤 Name : Hidden 😛',
                '📍 Location : Pakistan',
                '💼 Role : Bot Developer & Tech Support',
                '🌐 Services\n• WhatsApp Bots\n• Telegram Bots\n• Smart Automation',
                '📧 Email : paidwhatsappbot.com',
                '💬 Telegram\n🔗 https://t.me/paid_whatsapp_bot',
                '📱 WhatsApp Contact\n🔗 https://whatsapp.com/channel/0029Vasn4ipCBtxCxfJqgV3S',
                '━━━━━━━━━━━━━━━━━━━━━━\n©ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴘᴀɪᴅ ᴡʜᴀᴛsᴀᴘᴘ ʙᴏᴛ\n━━━━━━━━━━━━━━━━━━━━━━'
            ];

            for (let msg of messages) {
                await wasi_sock.sendMessage(wasi_sender, { text: msg });
                await new Promise(r => setTimeout(r, 500)); // 0.5 sec delay
            }

        } catch (error) {
            console.error(error);
            await wasi_sock.sendMessage(wasi_sender, { text: 'Failed to send owner info.' });
        }
    }
};
