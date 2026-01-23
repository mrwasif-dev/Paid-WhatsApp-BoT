const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

async function handleGroupParticipantsUpdate(sock, update, config) {
    const { id, participants, action } = update;

    console.log('Group Event:', action, id);

    if (!config.autoWelcome && !config.autoGoodbye) return;

    try {
        const metadata = await sock.groupMetadata(id);
        const groupName = metadata.subject;

        for (const participant of participants) {
            if (typeof participant !== 'string') continue;
            const userName = participant.split('@')[0];

            if (action === 'add' && config.autoWelcome) {
                // WELCOME MESSAGE
                let text = config.welcomeMessage || "Hello @user, Welcome to @group! 👋";
                text = text.replace(/@user/g, `@${userName}`);
                text = text.replace(/@group/g, groupName);

                await sock.sendMessage(id, {
                    text: text,
                    contextInfo: {
                        mentionedJid: [participant],
                        externalAdReply: {
                            title: `WELCOME TO ${groupName.toUpperCase()}`,
                            body: `Member: @${userName}`,
                            thumbnailUrl: 'https://files.catbox.moe/ifruw6.jpg', // Default bot menu image
                            sourceUrl: 'https://whatsapp.com/channel/0029Vb6nBy3AYlUNu527gF1q',
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                });

            } else if (action === 'remove' && config.autoGoodbye) {
                // GOODBYE MESSAGE
                let text = config.goodbyeMessage || "@user Left the group. 👋";
                text = text.replace(/@user/g, `@${userName}`);
                text = text.replace(/@group/g, groupName);

                await sock.sendMessage(id, {
                    text: text,
                    contextInfo: {
                        mentionedJid: [participant],
                        externalAdReply: {
                            title: `GOODBYE FROM ${groupName.toUpperCase()}`,
                            body: `User: @${userName}`,
                            thumbnailUrl: 'https://files.catbox.moe/ifruw6.jpg',
                            sourceUrl: 'https://whatsapp.com/channel/0029Vb6nBy3AYlUNu527gF1q',
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.error('Error handling group update:', err.message);
    }
}

module.exports = { handleGroupParticipantsUpdate };
