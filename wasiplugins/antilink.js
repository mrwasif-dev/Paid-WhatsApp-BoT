const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'antilink',
    description: 'Advanced Anti-Link system for groups',
    aliases: ['link'],
    category: 'Group',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId, wasi_msg } = context;

        if (!wasi_isGroup) {
            return await sock.sendMessage(from, { text: '❌ This command is only for groups.' });
        }

        if (!wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ You need to be an Admin to use this command.' });
        }

        const action = wasi_args[0]?.toLowerCase();
        const current = await wasi_getGroupSettings(sessionId, from) || {};

        // Show status if no args
        if (!action) {
            const status = current.antilink ? '🟢 ON' : '🔴 OFF';
            const mode = current.antilinkMode || 'delete';
            const maxWarn = current.antilinkMaxWarnings || 3;
            const whitelist = current.antilinkWhitelist || [];

            let text = `🛡️ *ANTI-LINK SETTINGS*\n\n`;
            text += `📌 *Status:* ${status}\n`;
            text += `⚙️ *Mode:* ${mode}\n`;
            text += `⚠️ *Max Warnings:* ${maxWarn}\n`;
            text += `📝 *Whitelisted:* ${whitelist.length > 0 ? whitelist.join(', ') : 'None'}\n\n`;
            text += `*Available Commands:*\n`;
            text += `• \`.antilink on\` - Enable\n`;
            text += `• \`.antilink off\` - Disable\n`;
            text += `• \`.antilink warn\` - Set mode to warn\n`;
            text += `• \`.antilink delete\` - Set mode to delete only\n`;
            text += `• \`.antilink remove\` - Set mode to kick user\n`;
            text += `• \`.antilink maxwarn <num>\` - Set max warnings\n`;
            text += `• \`.antilink whitelist <domain>\` - Add to whitelist\n`;
            text += `• \`.antilink unwhitelist <domain>\` - Remove from whitelist\n`;
            text += `• \`.antilink reset\` - Reset all warnings`;

            return await sock.sendMessage(from, { text });
        }

        // On/Off
        if (action === 'on') {
            await wasi_updateGroupSettings(sessionId, from, { antilink: true });
            return await sock.sendMessage(from, { text: `🛡️ *Anti-Link* has been *ENABLED* for this group.\n\nMode: *${current.antilinkMode || 'delete'}*` });
        }

        if (action === 'off') {
            await wasi_updateGroupSettings(sessionId, from, { antilink: false });
            return await sock.sendMessage(from, { text: `🛡️ *Anti-Link* has been *DISABLED* for this group.` });
        }

        // Mode settings
        if (action === 'warn') {
            await wasi_updateGroupSettings(sessionId, from, { antilinkMode: 'warn' });
            return await sock.sendMessage(from, { text: `⚠️ Anti-Link mode set to *WARN*.\n\nUsers will be warned before action is taken.` });
        }

        if (action === 'delete') {
            await wasi_updateGroupSettings(sessionId, from, { antilinkMode: 'delete' });
            return await sock.sendMessage(from, { text: `🗑️ Anti-Link mode set to *DELETE*.\n\nLinks will be deleted without warning.` });
        }

        if (action === 'remove' || action === 'kick') {
            await wasi_updateGroupSettings(sessionId, from, { antilinkMode: 'remove' });
            return await sock.sendMessage(from, { text: `🚫 Anti-Link mode set to *REMOVE*.\n\nUsers will be kicked after sending a link (or after max warnings if warn mode).` });
        }

        // Max warnings
        if (action === 'maxwarn') {
            const num = parseInt(wasi_args[1]);
            if (!num || num < 1 || num > 10) {
                return await sock.sendMessage(from, { text: '❌ Please provide a number between 1-10.\n\nUsage: `.antilink maxwarn 3`' });
            }
            await wasi_updateGroupSettings(sessionId, from, { antilinkMaxWarnings: num });
            return await sock.sendMessage(from, { text: `✅ Max warnings set to *${num}*` });
        }

        // Whitelist
        if (action === 'whitelist') {
            const domain = wasi_args[1]?.toLowerCase();
            if (!domain) {
                return await sock.sendMessage(from, { text: '❌ Please provide a domain.\n\nUsage: `.antilink whitelist youtube.com`' });
            }
            const whitelist = current.antilinkWhitelist || [];
            if (whitelist.includes(domain)) {
                return await sock.sendMessage(from, { text: `⚠️ *${domain}* is already whitelisted.` });
            }
            whitelist.push(domain);
            await wasi_updateGroupSettings(sessionId, from, { antilinkWhitelist: whitelist });
            return await sock.sendMessage(from, { text: `✅ *${domain}* has been whitelisted.\n\nLinks from this domain will be allowed.` });
        }

        if (action === 'unwhitelist' || action === 'blacklist') {
            const domain = wasi_args[1]?.toLowerCase();
            if (!domain) {
                return await sock.sendMessage(from, { text: '❌ Please provide a domain.\n\nUsage: `.antilink unwhitelist youtube.com`' });
            }
            let whitelist = current.antilinkWhitelist || [];
            if (!whitelist.includes(domain)) {
                return await sock.sendMessage(from, { text: `⚠️ *${domain}* is not in the whitelist.` });
            }
            whitelist = whitelist.filter(d => d !== domain);
            await wasi_updateGroupSettings(sessionId, from, { antilinkWhitelist: whitelist });
            return await sock.sendMessage(from, { text: `✅ *${domain}* has been removed from whitelist.` });
        }

        // Reset warnings
        if (action === 'reset') {
            await wasi_updateGroupSettings(sessionId, from, { antilinkWarnings: {} });
            return await sock.sendMessage(from, { text: `✅ All antilink warnings have been reset.` });
        }

        // Unknown action
        return await sock.sendMessage(from, { text: `❌ Unknown action. Use \`.antilink\` to see available options.` });
    }
};
