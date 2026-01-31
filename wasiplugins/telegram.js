// Telegram Plugin for WASI-MD-V7
const TelegramBot = require('node-telegram-bot-api');

module.exports = {
    name: 'telegram',
    init: () => {
        // Telegram Bot Token (hardcoded)
        const TELEGRAM_TOKEN = '8590226878:AAEVdwmNgN_P8mZvQGSs8p4UqHmOfsfxjsc';

        if (!TELEGRAM_TOKEN) {
            console.log('Telegram token not set!');
            return;
        }

        // Initialize Telegram bot with polling
        const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

        // Log to console when plugin is running
        console.log('Telegram plugin initialized and running...');

        // Handle /start command
        bot.onText(/\/start/, (msg) => {
            bot.sendMessage(
                msg.chat.id,
                `Hello ${msg.from.first_name}! Telegram bot is running.`
            );
        });

        // Handle any normal text messages
        bot.on('message', (msg) => {
            // Ignore commands (they start with /)
            if (!msg.text.startsWith('/')) {
                bot.sendMessage(msg.chat.id, `You said: ${msg.text}`);
            }
        });
    }
};
