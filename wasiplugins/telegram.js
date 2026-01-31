const TelegramBot = require('node-telegram-bot-api');

module.exports = {
    name: 'telegram',
    init: () => {
        // Telegram bot token (hardcoded)
        const TELEGRAM_TOKEN = '8590226878:AAEVdwmNgN_P8mZvQGSs8p4UqHmOfsfxjsc';

        if (!TELEGRAM_TOKEN) {
            console.log('Telegram token not set!');
            return;
        }

        // Initialize the Telegram bot
        const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

        // Handle /start command
        bot.onText(/\/start/, (msg) => {
            bot.sendMessage(msg.chat.id, `Hello ${msg.from.first_name}! Telegram bot is running.`);
        });

        // Handle any text message
        bot.on('message', (msg) => {
            if (!msg.text.startsWith('/')) {
                bot.sendMessage(msg.chat.id, `You said: ${msg.text}`);
            }
        });

        console.log('Telegram plugin initialized and running...');
    }
};
