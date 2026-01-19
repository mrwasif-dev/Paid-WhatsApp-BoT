const moment = require('moment-timezone');

module.exports = {
    name: 'gs',
    aliases: ['groupstatus', 'ginfo'],
    category: 'Group',
    desc: 'Get group information/status.',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_isGroup, wasi_isAdmin, wasi_botIsAdmin, wasi_args } = context;

        if (!wasi_isGroup) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ This command can only be used in groups.' });
        }

        // If arguments are provided, user wants to SET status
        if (wasi_args && wasi_args.length > 0) {
            if (!wasi_isAdmin) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ You must be an admin to change group settings.' });
            }
            if (!wasi_botIsAdmin) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ I need to be an admin to change settings.' });
            }

            const action = wasi_args[0].toLowerCase();

            try {
                if (action === 'close' || action === 'mute') {
                    await wasi_sock.groupSettingUpdate(wasi_sender, 'announcement');
                    return await wasi_sock.sendMessage(wasi_sender, { text: '🔒 *Group Closed!* Only admins can send messages.' });
                } else if (action === 'open' || action === 'unmute') {
                    await wasi_sock.groupSettingUpdate(wasi_sender, 'not_announcement');
                    return await wasi_sock.sendMessage(wasi_sender, { text: '🔓 *Group Opened!* All participants can send messages.' });
                } else if (action === 'lock') {
                    await wasi_sock.groupSettingUpdate(wasi_sender, 'locked');
                    return await wasi_sock.sendMessage(wasi_sender, { text: '🔒 *Group Info Locked!* Only admins can edit group info.' });
                } else if (action === 'unlock') {
                    await wasi_sock.groupSettingUpdate(wasi_sender, 'unlocked');
                    return await wasi_sock.sendMessage(wasi_sender, { text: '🔓 *Group Info Unlocked!* All participants can edit group info.' });
                } else {
                    return await wasi_sock.sendMessage(wasi_sender, {
                        text: '❌ Invalid option.\nUsage: `.gs open`, `.gs close`, `.gs lock`, `.gs unlock`'
                    });
                }
            } catch (e) {
                console.error('GS Update Error:', e);
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to update group settings.' });
            }
        }

        // If no arguments, show INFO (Existing logic)
        try {
            const metadata = await wasi_sock.groupMetadata(wasi_sender);
            const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
            const owner = metadata.owner || admins.find(p => p.admin === 'superadmin');

            let text = `*📊 GROUP STATUS 📊*\n\n`;
            text += `🏷️ *Subject:* ${metadata.subject}\n`;
            text += `👥 *Members:* ${metadata.participants.length}\n`;
            text += `👮 *Admins:* ${admins.length}\n`;
            text += `� *Msg Status:* ${metadata.announce ? 'Admins Only' : 'All Members'}\n`;
            text += `✏️ *Edit Info:* ${metadata.restrict ? 'Admins Only' : 'All Members'}\n\n`;
            text += `*Usage:* \`.gs open/close/lock/unlock\``;

            await wasi_sock.sendMessage(wasi_sender, {
                text: text,
                mentions: [owner]
            });

        } catch (e) {
            console.error(e);
            await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to fetch group metadata.' });
        }
    }
};
