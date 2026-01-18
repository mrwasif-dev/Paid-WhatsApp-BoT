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
                let text = config.welcomeMessage || "Hello @user, Welcome to @group!";
                text = text.replace(/@user/g, `@${userName}`);
                text = text.replace(/@group/g, groupName);

                await sock.sendMessage(id, {
                    text: text,
                    mentions: [participant]
                });

            } else if (action === 'remove' && config.autoGoodbye) {
                // GOODBYE MESSAGE
                let text = config.goodbyeMessage || "@user Left the group.";
                text = text.replace(/@user/g, `@${userName}`);
                text = text.replace(/@group/g, groupName);

                await sock.sendMessage(id, {
                    text: text,
                    mentions: [participant]
                });
            }
        }
    } catch (err) {
        console.error('Error handling group update:', err);
    }
}

module.exports = { handleGroupParticipantsUpdate };
