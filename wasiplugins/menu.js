const os = require('os');
const moment = require('moment-timezone');
const process = require('process');

module.exports = {
    name: 'menu',
    aliases: ['help', 'commands', 'list'],
    category: 'General',
    desc: 'Show all available commands',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {

        const { wasi_plugins, wasi_msg } = context;
        const config = require('../wasi');

        // Configuration from Wasi.js
        const BOT_NAME = config.botName;
        const MODE = config.mode;
        const PREFIX = config.prefix;
        const IMAGE_URL = config.menuImage;

        // Utility: Format Runtime
        const wasi_uptime = process.uptime();
        const wasi_fmt_uptime = [
            Math.floor(wasi_uptime / 3600).toString().padStart(2, '0') + 'h',
            Math.floor((wasi_uptime % 3600) / 60).toString().padStart(2, '0') + 'm',
            Math.floor(wasi_uptime % 60).toString().padStart(2, '0') + 's'
        ].join(' ');

        // Utility: RAM Usage
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
        const usedMem = (totalMem - freeMem).toFixed(2);

        // Utility: Time
        const time = moment().tz(config.timeZone).format('hh:mm:ss a');

        // User Name
        const userName = wasi_msg.pushName || 'User';

        // Categorize Commands
        const wasi_categories = new Map();
        const wasi_unique_plugins = new Set(wasi_plugins.values());

        for (const wasi_plugin of wasi_unique_plugins) {
            const wasi_cat = wasi_plugin.category || 'Other';
            if (!wasi_categories.has(wasi_cat)) {
                wasi_categories.set(wasi_cat, []);
            }
            wasi_categories.get(wasi_cat).push(wasi_plugin.name);
        }

        // Construct Menu Text
        let menuText = `┏ 💐 ${BOT_NAME} 💐 ┓\n`;
        menuText += `👋 HELLO, ${userName.toUpperCase()}!\n`;
        menuText += `┗━━━━━━━━━━━━━━━┛\n`;
        menuText += `┏ COMMAND PANEL ┓\n`;
        menuText += `🔹 RUN   : ${wasi_fmt_uptime}\n`;
        menuText += `🔹 MODE  : ${MODE}\n`;
        menuText += `🔹 PREFIX: ${PREFIX}\n`;
        menuText += `🔹 RAM   : ${usedMem} / ${totalMem} GB\n`;
        menuText += `🔹 TIME  : ${time}\n`;
        menuText += `🔹 USER  : ${userName}\n`;
        menuText += `┗━━━━━━━━━━━━━━━┛\n\n`;

        // Add Categories
        const sortedCategories = Array.from(wasi_categories.keys()).sort();
        for (const category of sortedCategories) {
            menuText += `┏━┫ *${category.toUpperCase()}* ┣━┓\n`;
            const commands = wasi_categories.get(category).sort();
            for (const cmd of commands) {
                menuText += `┣ ◦ ${cmd}\n`;
            }
            menuText += `┗━━━━━━━━━━━━━━━┛\n`;
        }

        menuText += `\n✨ _Powered by ${BOT_NAME}_`;

        // Send Message
        try {
            await wasi_sock.sendMessage(wasi_sender, {
                image: { url: IMAGE_URL },
                caption: menuText
            });
        } catch (e) {
            // Fallback to text if image fails
            await wasi_sock.sendMessage(wasi_sender, { text: menuText });
        }
    }
};
