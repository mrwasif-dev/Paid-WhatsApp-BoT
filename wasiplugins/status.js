const { wasi_isDbConnected, wasi_getUserAutoStatus, wasi_setUserAutoStatus } = require('../wasilib/database');

module.exports = {
    name: 'status',
    aliases: ['autostatus', 'statusview'],
    category: 'Settings',
    desc: 'Toggle auto status viewing for your statuses',
    ownerOnly: true, // Only owner can use this command
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args } = context;

        if (!wasi_isDbConnected()) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ Database is not connected. This feature requires MongoDB.'
            });
        }

        // Get current settings
        const currentSettings = await wasi_getUserAutoStatus(wasi_sender);
        const isCurrentlyEnabled = currentSettings?.autoStatusSeen || false;

        // Parse arguments
        const arg = wasi_args?.toLowerCase()?.trim();

        if (arg === 'on' || arg === 'enable') {
            await wasi_setUserAutoStatus(wasi_sender, {
                autoStatusSeen: true,
                autoStatusReact: true,
                autoStatusMessage: true
            });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '✅ *Auto Status Enabled!*\n\n' +
                    '👁️ Your statuses will be auto-viewed\n' +
                    '❤️ Heart react will be sent\n' +
                    '💬 You will receive a notification message'
            });
        }

        if (arg === 'off' || arg === 'disable') {
            await wasi_setUserAutoStatus(wasi_sender, {
                autoStatusSeen: false,
                autoStatusReact: false,
                autoStatusMessage: false
            });
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Auto Status Disabled!*\n\nYour statuses will no longer be auto-viewed.'
            });
        }

        // Show current status and usage
        const statusText = isCurrentlyEnabled ? '🟢 ON' : '🔴 OFF';
        return wasi_sock.sendMessage(wasi_sender, {
            text: `📊 *Auto Status Settings*\n\n` +
                `Current Status: ${statusText}\n\n` +
                `*Usage:*\n` +
                `• \`.status on\` - Enable auto status\n` +
                `• \`.status off\` - Disable auto status`
        });
    }
};
