const { wasi_getXP, wasi_getLeaderboard } = require('../wasilib/database');

module.exports = {
    name: 'wasirank',
    description: 'Check your rank card or leaderboard',
    aliases: ['rank', 'profile', 'level', 'top'],
    category: 'Games',
    wasi_handler: async (sock, from, context) => {
        const { wasi_sender, wasi_msg, wasi_args, wasi_text, sessionId, wasi_isGroup } = context;
        const cmd = wasi_text.trim().split(' ')[0].toLowerCase(); // .rank or .top

        // --- TOP / LEADERBOARD ---
        if (cmd.includes('top') || cmd.includes('leaderboard')) {
            const leaderboard = await wasi_getLeaderboard(sessionId, 10);

            if (!leaderboard.length) {
                return await sock.sendMessage(from, { text: '❌ No ranked users yet.' });
            }

            let text = `🏆 *TOP 10 LEADERBOARD* 🏆\n\n`;
            leaderboard.forEach((user, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '▫️';
                // Try to format JID cleanly
                const name = '@' + user.jid.split('@')[0];
                text += `${medal} *#${index + 1}* ${name}\n`;
                text += `   💪 XP: ${user.xp} | 🎖️ Lvl: ${user.level} | ${user.role}\n\n`;
            });

            return await sock.sendMessage(from, {
                text: text,
                mentions: leaderboard.map(u => u.jid)
            }, { quoted: wasi_msg });
        }

        // --- RANK CARD (PROFILE) ---
        let target = wasi_sender;
        if (wasi_isGroup) {
            const mentions = wasi_msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length > 0) target = mentions[0];
            else if (wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
                target = wasi_msg.message.extendedTextMessage.contextInfo.participant || wasi_sender;
            }
        }

        const data = await wasi_getXP(sessionId, target);

        let ppUrl = 'https://i.pinimg.com/564x/8a/92/83/8a9283733055375498875323cb639446.jpg'; // default
        try {
            ppUrl = await sock.profilePictureUrl(target, 'image');
        } catch { }

        // We can generate a fancy image using canvas, but for stability, let's use a nice text + thumbnail layout first.
        // Or pull a rank card API. Vreden has one.

        const rankCardUrl = `https://api.vreden.my.id/api/v1/canvas/rank?avatar=${encodeURIComponent(ppUrl)}&username=${encodeURIComponent(target.split('@')[0])}&bg=${encodeURIComponent('https://images.unsplash.com/photo-1579546929518-9e396f3cc809?ixlib=rb-1.2.1&q=80&fm=jpg&crop=entropy&cs=tinysrgb&w=1080&fit=max')}&level=${data.level}&xp=${data.xp}&neededxp=${(data.level + 1) ** 2 * 100}&discriminator=0000`;

        await sock.sendMessage(from, {
            image: { url: rankCardUrl },
            caption: `👤 *USER PROFILE*\n\n` +
                `📛 *Name:* @${target.split('@')[0]}\n` +
                `🛡️ *Role:* ${data.role}\n` +
                `🆙 *Level:* ${data.level}\n` +
                `✨ *XP:* ${data.xp}\n`,
            mentions: [target]
        }, { quoted: wasi_msg });
    }
};
