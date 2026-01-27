const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { wasi_getGroupSettings } = require('./database');
const { Welcomer, Leaver } = require('canvacord');

async function handleGroupParticipantsUpdate(sock, update, config, sessionId) {
    const { id, participants, action } = update;

    // console.log('Group Event:', action, id);

    try {
        // 1. Get Group Metadata (for name and member count)
        const metadata = await sock.groupMetadata(id).catch(() => null);
        if (!metadata) return;

        const groupName = metadata.subject;
        const memberCount = metadata.participants.length;

        // 2. Get Group Specific Settings
        const settings = await wasi_getGroupSettings(sessionId, id);

        // Determine if we should act (Group Settings take precedence, fallback to global config if group setting is undefined? 
        // Usually turned off by default in DB schema, so if not explicitly enabled in Group, check global? 
        // For now, let's treat Group Settings as the source of truth. If specific toggle is ON, do it.)

        const doWelcome = settings?.welcome || (config.autoWelcome && !settings);
        const doGoodbye = settings?.goodbye || (config.autoGoodbye && !settings);

        if (!doWelcome && !doGoodbye) return;

        for (const participant of participants) {
            if (typeof participant !== 'string') continue;
            const userName = participant.split('@')[0];

            // Get PP
            let ppUrl = 'https://i.pinimg.com/564x/8a/92/83/8a9283733055375498875323cb639446.jpg';
            try {
                ppUrl = await sock.profilePictureUrl(participant, 'image');
            } catch { }

            if (action === 'add' && doWelcome) {
                // --- WELCOME ---
                let buffer;
                try {
                    const card = new Welcomer()
                        .setUsername(userName)
                        .setDiscriminator('0000')
                        .setMemberCount(memberCount)
                        .setAvatar(ppUrl)
                        .setBackground('https://images.unsplash.com/photo-1492684223066-81342ee5ff30') // Nature/Dark background
                        .setGuildName(groupName)
                        .setColor("title", "#ffffff")
                        .setColor("username-box", "#ffffff")
                        .setColor("discriminator-box", "#ffffff")
                        .setColor("message-box", "#ffffff")
                        .setColor("border", "#000000") // Border color
                        .setColor("avatar", "#000000"); // Avatar border color

                    buffer = await card.build();
                } catch (e) {
                    console.error('Welcome Card Error:', e);
                }

                let text = settings?.welcomeMessage || config.welcomeMessage || "Hello @user, Welcome to @group! 👋";
                text = text.replace(/@user/g, `@${userName}`).replace(/@group/g, groupName);

                if (buffer) {
                    await sock.sendMessage(id, {
                        image: buffer,
                        caption: text,
                        mentions: [participant]
                    });
                } else {
                    await sock.sendMessage(id, {
                        text: text,
                        mentions: [participant]
                    });
                }

            } else if (action === 'remove' && doGoodbye) {
                // --- GOODBYE ---
                let buffer;
                try {
                    const card = new Leaver()
                        .setUsername(userName)
                        .setDiscriminator('0000')
                        .setMemberCount(memberCount)
                        .setAvatar(ppUrl)
                        .setBackground('https://images.unsplash.com/photo-1516541196182-6bdb0516ed27') // Moody background
                        .setGuildName(groupName)
                        .setColor("title", "#ffffff")
                        .setColor("username-box", "#ffffff")
                        .setColor("discriminator-box", "#ffffff")
                        .setColor("message-box", "#ffffff")
                        .setColor("border", "#000000")
                        .setColor("avatar", "#000000");

                    buffer = await card.build();
                } catch (e) {
                    console.error('Goodbye Card Error:', e);
                }

                let text = settings?.goodbyeMessage || config.goodbyeMessage || "@user Left the group. 👋";
                text = text.replace(/@user/g, `@${userName}`).replace(/@group/g, groupName);

                if (buffer) {
                    await sock.sendMessage(id, {
                        image: buffer,
                        caption: text,
                        mentions: [participant]
                    });
                } else {
                    await sock.sendMessage(id, {
                        text: text,
                        mentions: [participant]
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error handling group update:', err.message);
    }
}

module.exports = { handleGroupParticipantsUpdate };
