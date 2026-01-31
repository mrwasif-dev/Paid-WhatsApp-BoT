const TelegramBot = require('node-telegram-bot-api');

module.exports = {
    name: 'telegram',
    init: () => {
        const TELEGRAM_TOKEN = 'YOUR_TELEGRAM_TOKEN_HERE';
        if (!TELEGRAM_TOKEN) return console.log('Telegram token missing');

        const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
        console.log('Telegram plugin initialized...');

        bot.onText(/\/start/, (msg) => {
            bot.sendMessage(msg.chat.id, `Hello ${msg.from.first_name}! Bot is running.`);
        });

        bot.on('message', (msg) => {
            if (!msg.text.startsWith('/')) {
                bot.sendMessage(msg.chat.id, `You said: ${msg.text}`);
            }
        });
    }
};
