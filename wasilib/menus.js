const moment = require('moment-timezone');
const process = require('process');
const config = require('../wasi');

const TIMEZONE = 'Asia/Karachi';

/* ================= SYSTEM INFO ================= */
const getSystemInfo = () => {
    const uptime = process.uptime();

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const fmtUptime = `${days}d ${hours}h ${minutes}m ${seconds}s`;

    const now = moment().tz(TIMEZONE);

    const currentTime = now.format('hh:mm:ss a');
    const currentDate = now.format('DD/MM/YYYY');

    const startTime = now.clone().subtract(uptime, 'seconds');
    const botStartTime = startTime.format('hh:mm:ss a');
    const botStartDate = startTime.format('DD/MM/YYYY');

    return {
        uptime: fmtUptime,
        currentTime,
        currentDate,
        botStartTime,
        botStartDate
    };
};

/* ================= COMMANDS ================= */
const getCommands = (wasi_plugins) => {
    const categories = new Map();
    const uniquePlugins = new Set(wasi_plugins.values());

    for (const plugin of uniquePlugins) {
        const category = plugin.category || 'Other';
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(plugin.name);
    }

    return Array.from(categories.keys()).sort().map(cat => ({
        category: cat,
        cmds: categories.get(cat).sort()
    }));
};

/* ================= MENU CARD ================= */
const buildMenuCard = (wasi_plugins) => {
    const info = getSystemInfo();
    const cmds = getCommands(wasi_plugins);

    // fixed width for labels
    const labelWidth = 12;

    let text = '';
    text += `${'UPTIME'.padEnd(labelWidth)}: ${info.uptime}\n`;
    text += `${'STARTED AT'.padEnd(labelWidth)}: ${info.botStartTime} | ${info.botStartDate}\n`;
    text += `${'NOW Time'.padEnd(labelWidth)}: ${info.currentTime} | ${info.currentDate}\n`;
    text += `━━━━━━━━━━━━━━━━━━\n\n`;

    for (const cat of cmds) {
        text += `[ ${cat.category.toUpperCase()} ]\n`;
        for (const cmd of cat.cmds) {
            text += `${config.prefix}${cmd}\n`;
        }
        text += `\n`;
    }

    return text.trim();
};

/* ================= EXPORT ================= */
const getMenu = (wasi_plugins) => {
    return buildMenuCard(wasi_plugins);
};

module.exports = { getMenu };
