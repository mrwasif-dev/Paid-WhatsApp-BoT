module.exports = {
    name: 'invite',
    aliases: ['link', 'grouplink'],
    category: 'Group',
    desc: 'Get the group invite link',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_isGroup, wasi_botIsAdmin } = context;

        if (!wasi_isGroup) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ This command can only be used in groups.' });
        }

        if (!wasi_botIsAdmin) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ I need to be an admin to generate the invite link.' });
        }

        try {
            const code = await wasi_sock.groupInviteCode(wasi_sender);
            const link = `https://chat.whatsapp.com/${code}`;

            await wasi_sock.sendMessage(wasi_sender, {
                text: `🔗 *Group Invite Link:*\n\n${link}`,
                contextInfo: {
                    externalAdReply: {
                        title: 'Group Invite',
                        body: 'Join this group',
                        thumbnailUrl: 'https://i.ibb.co/31z1z8d/invite.png', // Optional placeholder
                        sourceUrl: link,
                        mediaType: 1
                    }
                }
            });

        } catch (e) {
            console.error('Invite Command Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to fetch invite link.' });
        }
    }
};
