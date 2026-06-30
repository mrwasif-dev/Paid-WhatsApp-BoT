
require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

// ============================================================
// CONFIGURATION
// ============================================================

// Load persistent config
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        Object.assign(config, savedConfig);
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

// ============================================================
// SESSION STATE
// ============================================================

const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// ============================================================
// BOT CONFIGURATION
// ============================================================

const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

// Bot Owner (Default from env or hardcoded)
const BOT_OWNER = process.env.BOT_OWNER || '923047462950@s.whatsapp.net';

// Command Prefix
const PREFIX = process.env.COMMAND_PREFIX || '.';

// ============================================================
// SETTINGS WITH TOGGLES
// ============================================================

let settings = {
    antiDelete: true,
    autoDeleteLink: true,
    antiPromote: true,
    antiDemote: true,
    welcomeMessage: true,
    goodbyeMessage: true,
    autoForward: true,
    messageClean: true
};

// Load saved settings
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        if (saved.settings) {
            settings = { ...settings, ...saved.settings };
        }
    }
} catch (e) {}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Check if user is bot owner
 */
function isOwner(jid) {
    return jid === BOT_OWNER || jid.includes(BOT_OWNER.split('@')[0]);
}

/**
 * Check if user is admin in group
 */
async function isUserAdmin(sock, groupJid, userJid) {
    try {
        const metadata = await sock.groupMetadata(groupJid);
        const participant = metadata.participants.find(p => p.id === userJid);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch (e) {
        return false;
    }
}

/**
 * Check if bot is admin in group
 */
async function isBotAdmin(sock, groupJid) {
    try {
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const metadata = await sock.groupMetadata(groupJid);
        const participant = metadata.participants.find(p => p.id === botJid);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch (e) {
        return false;
    }
}

/**
 * Get group name
 */
async function getGroupName(sock, groupJid) {
    try {
        const metadata = await sock.groupMetadata(groupJid);
        return metadata.subject || 'Unknown Group';
    } catch (e) {
        return 'Unknown Group';
    }
}

/**
 * Get user name from group
 */
async function getUserName(sock, groupJid, userJid) {
    try {
        const metadata = await sock.groupMetadata(groupJid);
        const participant = metadata.participants.find(p => p.id === userJid);
        return participant?.name || participant?.notify || userJid.split('@')[0];
    } catch (e) {
        return userJid.split('@')[0];
    }
}

/**
 * Clean forwarded label from message
 */
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        const messageTypes = [
            'extendedTextMessage',
            'imageMessage',
            'videoMessage',
            'audioMessage',
            'documentMessage',
            'stickerMessage'
        ];
        
        messageTypes.forEach(type => {
            if (cleanedMessage[type]?.contextInfo) {
                cleanedMessage[type].contextInfo.isForwarded = false;
                cleanedMessage[type].contextInfo.forwardingScore = 0;
                delete cleanedMessage[type].contextInfo.forwardedNewsletterMessageInfo;
            }
        });
        
        // Remove protocol messages
        if (cleanedMessage.protocolMessage) {
            delete cleanedMessage.protocolMessage;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

/**
 * Clean newsletter/information markers from text
 */
function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi,
        /Broadcast:/gi,
        /Announcement:/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /This is a broadcast message/gi,
        /\(Forwarded\)/gi,
        /\[Forwarded\]/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

/**
 * Replace caption text using regex patterns
 */
function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    return result;
}

/**
 * Process and clean a message completely
 */
function processAndCleanMessage(originalMessage) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        
        if (settings.messageClean) {
            cleanedMessage = cleanForwardedLabel(cleanedMessage);
        }
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text && settings.messageClean) {
            const cleanedText = cleanNewsletterText(text);
            
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        // Remove context info for newsletter/broadcast
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

/**
 * .ping - Ping command
 */
async function handlePing(sock, from) {
    const start = Date.now();
    await sock.sendMessage(from, { text: "🏓 Pong!" });
    const end = Date.now();
    await sock.sendMessage(from, { text: `⏱️ Response time: ${end - start}ms` });
}

/**
 * .jid - Get JID
 */
async function handleJid(sock, from, msg) {
    const jid = msg.key.participant || msg.key.remoteJid;
    await sock.sendMessage(from, { 
        text: `📌 *Your JID:*\n\`${jid}\`` 
    });
}

/**
 * .gjid - Get all groups JID
 */
async function handleGjid(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let response = "📌 *Groups List*\n\n";
        let count = 0;
        
        for (const [jid, group] of Object.entries(groups)) {
            count++;
            const name = group.subject || "Unnamed Group";
            const members = group.participants?.length || 0;
            response += `${count}. *${name}*\n`;
            response += `   👥 ${members} members\n`;
            response += `   🆔 \`${jid}\`\n\n`;
        }
        
        if (count === 0) {
            response = "❌ No groups found.";
        } else {
            response += `📊 *Total: ${count} groups*`;
        }
        
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error('GJID error:', error);
        await sock.sendMessage(from, { text: "❌ Error fetching groups." });
    }
}

/**
 * .forward - Forward message to JID
 */
async function handleForward(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
        await sock.sendMessage(from, { 
            text: `❌ Reply to a message to forward.\nExample: *${PREFIX}forward 923001234567@s.whatsapp.net*` 
        });
        return;
    }
    
    const targetJid = args[0];
    if (!targetJid || !targetJid.includes('@s.whatsapp.net')) {
        await sock.sendMessage(from, { 
            text: `❌ Provide valid JID.\nExample: *${PREFIX}forward 923001234567@s.whatsapp.net*` 
        });
        return;
    }
    
    try {
        const cleanedMsg = processAndCleanMessage(quotedMsg);
        await sock.relayMessage(targetJid, cleanedMsg, { 
            messageId: sock.generateMessageTag() 
        });
        
        await sock.sendMessage(from, { 
            text: `✅ Forwarded to \`${targetJid}\`` 
        });
    } catch (error) {
        console.error('Forward error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .caption - Change media caption
 */
async function handleCaption(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
        await sock.sendMessage(from, { 
            text: `❌ Reply to a media message.\nExample: *${PREFIX}caption New caption here*` 
        });
        return;
    }
    
    const newCaption = args.join(' ');
    if (!newCaption) {
        await sock.sendMessage(from, { 
            text: `❌ Provide a caption.\nExample: *${PREFIX}caption My new caption*` 
        });
        return;
    }
    
    try {
        const mediaType = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']
            .find(key => quotedMsg[key]);
        
        if (!mediaType) {
            await sock.sendMessage(from, { text: "❌ Reply to media only (image/video/document/audio)." });
            return;
        }
        
        const mediaBuffer = await sock.downloadMediaMessage(
            msg.message.extendedTextMessage.contextInfo.quotedMessage,
            'buffer'
        );
        
        const mediaMsg = quotedMsg[mediaType];
        const type = mediaType.replace('Message', '');
        
        await sock.sendMessage(from, {
            [type]: mediaBuffer,
            caption: newCaption,
            mimetype: mediaMsg.mimetype
        });
        
        await sock.sendMessage(from, { 
            text: `✅ Caption updated.\n📝 *${newCaption}*` 
        });
    } catch (error) {
        console.error('Caption error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .kick - Kick member from group
 */
async function handleKick(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    if (!from.includes('g.us')) {
        await sock.sendMessage(from, { text: "❌ Use in groups only." });
        return;
    }
    
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (!await isUserAdmin(sock, from, senderJid)) {
        await sock.sendMessage(from, { text: "❌ Only admins can kick." });
        return;
    }
    
    if (!await isBotAdmin(sock, from)) {
        await sock.sendMessage(from, { text: "❌ Bot needs admin to kick." });
        return;
    }
    
    let targetJid = null;
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
    
    if (quotedMsg?.stanzaId) {
        targetJid = quotedMsg.participant || quotedMsg.remoteJid;
    }
    
    if (!targetJid && quotedMsg?.mentionedJid) {
        targetJid = quotedMsg.mentionedJid[0];
    }
    
    if (!targetJid && args.length > 0) {
        targetJid = args[0].replace('@', '');
        if (!targetJid.includes('@s.whatsapp.net')) {
            targetJid += '@s.whatsapp.net';
        }
    }
    
    if (!targetJid) {
        await sock.sendMessage(from, { 
            text: `❌ Tag/reply to kick.\nExample: *${PREFIX}kick @user*` 
        });
        return;
    }
    
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    if (targetJid === botJid) {
        await sock.sendMessage(from, { text: "❌ Can't kick myself." });
        return;
    }
    
    if (isOwner(targetJid)) {
        await sock.sendMessage(from, { text: "❌ Can't kick bot owner." });
        return;
    }
    
    try {
        await sock.groupParticipantsUpdate(from, [targetJid], 'remove');
        const name = await getUserName(sock, from, targetJid);
        await sock.sendMessage(from, { 
            text: `✅ *${name}* kicked from group.` 
        });
    } catch (error) {
        console.error('Kick error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .add - Add member to group
 */
async function handleAdd(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    if (!from.includes('g.us')) {
        await sock.sendMessage(from, { text: "❌ Use in groups only." });
        return;
    }
    
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (!await isUserAdmin(sock, from, senderJid)) {
        await sock.sendMessage(from, { text: "❌ Only admins can add." });
        return;
    }
    
    if (!await isBotAdmin(sock, from)) {
        await sock.sendMessage(from, { text: "❌ Bot needs admin to add." });
        return;
    }
    
    const jid = args[0];
    if (!jid || !jid.includes('@s.whatsapp.net')) {
        await sock.sendMessage(from, { 
            text: `❌ Provide valid JID.\nExample: *${PREFIX}add 923001234567@s.whatsapp.net*` 
        });
        return;
    }
    
    try {
        await sock.groupParticipantsUpdate(from, [jid], 'add');
        await sock.sendMessage(from, { 
            text: `✅ \`${jid}\` added to group.` 
        });
    } catch (error) {
        console.error('Add error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .promote - Promote to admin
 */
async function handlePromote(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    if (!from.includes('g.us')) {
        await sock.sendMessage(from, { text: "❌ Use in groups only." });
        return;
    }
    
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (!isOwner(senderJid)) {
        await sock.sendMessage(from, { text: "❌ Only bot owner can promote." });
        return;
    }
    
    if (!await isBotAdmin(sock, from)) {
        await sock.sendMessage(from, { text: "❌ Bot needs admin to promote." });
        return;
    }
    
    let targetJid = null;
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
    
    if (quotedMsg?.stanzaId) {
        targetJid = quotedMsg.participant || quotedMsg.remoteJid;
    }
    if (!targetJid && quotedMsg?.mentionedJid) {
        targetJid = quotedMsg.mentionedJid[0];
    }
    if (!targetJid && args.length > 0) {
        targetJid = args[0].replace('@', '');
        if (!targetJid.includes('@s.whatsapp.net')) {
            targetJid += '@s.whatsapp.net';
        }
    }
    
    if (!targetJid) {
        await sock.sendMessage(from, { 
            text: `❌ Tag/reply to promote.\nExample: *${PREFIX}promote @user*` 
        });
        return;
    }
    
    try {
        await sock.groupParticipantsUpdate(from, [targetJid], 'promote');
        const name = await getUserName(sock, from, targetJid);
        await sock.sendMessage(from, { 
            text: `✅ *${name}* promoted to admin.` 
        });
    } catch (error) {
        console.error('Promote error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .demote - Demote from admin
 */
async function handleDemote(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    if (!from.includes('g.us')) {
        await sock.sendMessage(from, { text: "❌ Use in groups only." });
        return;
    }
    
    const senderJid = msg.key.participant || msg.key.remoteJid;
    if (!isOwner(senderJid)) {
        await sock.sendMessage(from, { text: "❌ Only bot owner can demote." });
        return;
    }
    
    if (!await isBotAdmin(sock, from)) {
        await sock.sendMessage(from, { text: "❌ Bot needs admin to demote." });
        return;
    }
    
    let targetJid = null;
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
    
    if (quotedMsg?.stanzaId) {
        targetJid = quotedMsg.participant || quotedMsg.remoteJid;
    }
    if (!targetJid && quotedMsg?.mentionedJid) {
        targetJid = quotedMsg.mentionedJid[0];
    }
    if (!targetJid && args.length > 0) {
        targetJid = args[0].replace('@', '');
        if (!targetJid.includes('@s.whatsapp.net')) {
            targetJid += '@s.whatsapp.net';
        }
    }
    
    if (!targetJid) {
        await sock.sendMessage(from, { 
            text: `❌ Tag/reply to demote.\nExample: *${PREFIX}demote @user*` 
        });
        return;
    }
    
    try {
        await sock.groupParticipantsUpdate(from, [targetJid], 'demote');
        const name = await getUserName(sock, from, targetJid);
        await sock.sendMessage(from, { 
            text: `✅ *${name}* demoted from admin.` 
        });
    } catch (error) {
        console.error('Demote error:', error);
        await sock.sendMessage(from, { text: `❌ Error: ${error.message}` });
    }
}

/**
 * .menu - Show all commands
 */
async function handleMenu(sock, from) {
    const menu = `
🤖 *BOT MENU*
━━━━━━━━━━━━━━━━

📌 *Basic Commands*
${PREFIX}ping - Check bot response time
${PREFIX}jid - Get your JID
${PREFIX}gjid - Get all groups JID
${PREFIX}menu - Show this menu

📤 *Forward Commands*
${PREFIX}forward [JID] - Forward replied message
${PREFIX}caption [text] - Change replied media caption

👑 *Admin Commands* (Group Only)
${PREFIX}kick @user - Kick member
${PREFIX}add [JID] - Add member
${PREFIX}promote @user - Promote to admin
${PREFIX}demote @user - Demote from admin

🔘 *Toggle Commands*
${PREFIX}antidel on/off - Anti-Delete
${PREFIX}autodel on/off - Auto delete links
${PREFIX}antipromote on/off - Anti-promote
${PREFIX}antidemote on/off - Anti-demote
${PREFIX}welcome on/off - Welcome message
${PREFIX}goodbye on/off - Goodbye message

⚙️ *Current Settings*
• Anti-Delete: ${settings.antiDelete ? '✅ ON' : '❌ OFF'}
• Auto-Delete Links: ${settings.autoDeleteLink ? '✅ ON' : '❌ OFF'}
• Anti-Promote: ${settings.antiPromote ? '✅ ON' : '❌ OFF'}
• Anti-Demote: ${settings.antiDemote ? '✅ ON' : '❌ OFF'}
• Welcome: ${settings.welcomeMessage ? '✅ ON' : '❌ OFF'}
• Goodbye: ${settings.goodbyeMessage ? '✅ ON' : '❌ OFF'}

━━━━━━━━━━━━━━━━
👑 *Bot Owner Only Commands*
• All admin commands
• Promote/Demote

💡 *Note:* Reply to a message to forward or change caption.
    `;
    
    await sock.sendMessage(from, { text: menu });
}

/**
 * .status - Show bot status
 */
async function handleStatus(sock, from) {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    const status = `
📊 *BOT STATUS*
━━━━━━━━━━━━━━━━

🟢 *Status:* Online
⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
👑 *Owner:* ${BOT_OWNER}
📱 *Phone:* ${sock.user?.id?.split(':')[0] || 'Unknown'}

⚙️ *Settings:*
• Anti-Delete: ${settings.antiDelete ? '✅' : '❌'}
• Auto-Delete Links: ${settings.autoDeleteLink ? '✅' : '❌'}
• Anti-Promote: ${settings.antiPromote ? '✅' : '❌'}
• Anti-Demote: ${settings.antiDemote ? '✅' : '❌'}
• Welcome: ${settings.welcomeMessage ? '✅' : '❌'}
• Goodbye: ${settings.goodbyeMessage ? '✅' : '❌'}

📦 *Auto Forward:*
• Sources: ${SOURCE_JIDS.length}
• Targets: ${TARGET_JIDS.length}
    `;
    
    await sock.sendMessage(from, { text: status });
}

/**
 * Handle toggle commands
 */
async function handleToggle(sock, from, feature, status) {
    if (status !== 'on' && status !== 'off') {
        await sock.sendMessage(from, {
            text: `❌ Use *on* or *off*\nExample: *${PREFIX}${feature} on*`
        });
        return;
    }
    
    const featureMap = {
        'antidel': 'antiDelete',
        'autodel': 'autoDeleteLink',
        'antipromote': 'antiPromote',
        'antidemote': 'antiDemote',
        'welcome': 'welcomeMessage',
        'goodbye': 'goodbyeMessage'
    };
    
    const key = featureMap[feature];
    if (!key) {
        await sock.sendMessage(from, {
            text: `❌ Invalid feature.\nAvailable: antidel, autodel, antipromote, antidemote, welcome, goodbye`
        });
        return;
    }
    
    settings[key] = status === 'on';
    
    // Save settings
    try {
        fs.writeFileSync(
            path.join(__dirname, 'botConfig.json'),
            JSON.stringify({ settings }, null, 2)
        );
    } catch (e) {}
    
    await sock.sendMessage(from, {
        text: `✅ *${feature}* is now ${status.toUpperCase()}`
    });
}

// ============================================================
// EVENT HANDLERS
// ============================================================

/**
 * Anti-Delete Handler
 */
async function handleAntiDelete(sock, deleteData) {
    if (!settings.antiDelete) return;
    if (!deleteData.jid?.includes('g.us')) return;
    
    try {
        const { keys, jid } = deleteData;
        
        for (const key of keys) {
            const senderJid = key.participant || key.remoteJid;
            if (isOwner(senderJid)) continue;
            
            const deletedMsg = key.message;
            if (!deletedMsg) continue;
            
            const groupName = await getGroupName(sock, jid);
            const senderName = await getUserName(sock, jid, senderJid);
            
            const text = deletedMsg.conversation ||
                        deletedMsg.extendedTextMessage?.text ||
                        deletedMsg.imageMessage?.caption ||
                        deletedMsg.videoMessage?.caption ||
                        deletedMsg.documentMessage?.caption ||
                        '(Media Message)';
            
            const info = `
🔴 *MESSAGE DELETED*
━━━━━━━━━━━━━━━━

📌 *Group:* ${groupName}
👤 *Deleted By:* ${senderName}
🆔 *JID:* ${senderJid}
🕐 *Time:* ${new Date().toLocaleString()}

📝 *Content:*
${text}
━━━━━━━━━━━━━━━━
🔒 *Saved to DM*
            `;
            
            await sock.sendMessage(BOT_OWNER, { text: info });
            console.log(`🔴 Anti-Delete: ${senderJid} in ${jid}`);
        }
    } catch (error) {
        console.error('Anti-Delete error:', error);
    }
}

/**
 * Anti-Link Handler
 */
async function handleAntiLink(sock, msg) {
    if (!settings.autoDeleteLink) return;
    
    const from = msg.key.remoteJid;
    if (!from.includes('g.us')) return;
    
    const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';
    
    const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi;
    
    if (urlPattern.test(text)) {
        const senderJid = msg.key.participant || msg.key.remoteJid;
        
        // Skip owner and admins
        if (isOwner(senderJid)) return;
        if (await isUserAdmin(sock, from, senderJid)) return;
        
        try {
            await sock.sendMessage(from, { delete: msg.key });
            console.log(`🔗 Auto-deleted link from ${senderJid}`);
        } catch (error) {
            console.error('Anti-Link error:', error);
        }
    }
}

/**
 * Anti-Promote/Demote Handler
 */
async function handleAntiPromoteDemote(sock, update) {
    if (!update.participants) return;
    
    const { jid, participants, action } = update;
    if (!jid.includes('g.us')) return;
    
    if (action === 'promote' && !settings.antiPromote) return;
    if (action === 'demote' && !settings.antiDemote) return;
    
    const actorJid = update.actor || update.participant;
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    
    // Skip if bot or owner did it
    if (actorJid === botJid || isOwner(actorJid)) return;
    
    try {
        const groupName = await getGroupName(sock, jid);
        const actorName = await getUserName(sock, jid, actorJid);
        
        for (const participant of participants) {
            const targetName = await getUserName(sock, jid, participant);
            const reverseAction = action === 'promote' ? 'demote' : 'promote';
            
            await sock.groupParticipantsUpdate(jid, [participant], reverseAction);
            
            const msg = `
🚨 *ANTI-${action === 'promote' ? 'PROMOTE' : 'DEMOTE'}*
━━━━━━━━━━━━━━━━

❌ *Attempted By:* ${actorName}
👤 *Target:* ${targetName}
📌 *Group:* ${groupName}
🕐 *Time:* ${new Date().toLocaleString()}

⚠️ Only bot owner can ${action === 'promote' ? 'promote' : 'demote'}!
🔒 Action reversed.
            `;
            
            await sock.sendMessage(jid, { text: msg });
            await sock.sendMessage(BOT_OWNER, { text: msg });
            console.log(`🛑 Anti-${action}: ${participant} in ${jid}`);
        }
    } catch (error) {
        console.error('Anti-Promote/Demote error:', error);
    }
}

/**
 * Welcome/Goodbye Handler
 */
async function handleWelcomeGoodbye(sock, update) {
    if (!update.participants) return;
    
    const { jid, participants, action } = update;
    if (!jid.includes('g.us')) return;
    
    try {
        const groupName = await getGroupName(sock, jid);
        
        if (action === 'add' && settings.welcomeMessage) {
            for (const participant of participants) {
                const name = participant.split('@')[0];
                await sock.sendMessage(jid, {
                    text: `👋 *Welcome to ${groupName}!*\n\nHello @${name}!\n\n📌 Please read the rules and enjoy!\n🎉 Have a great time!`,
                    mentions: [participant]
                });
            }
        }
        
        if (action === 'remove' && settings.goodbyeMessage) {
            for (const participant of participants) {
                const name = participant.split('@')[0];
                await sock.sendMessage(jid, {
                    text: `👋 *Goodbye!*\n\n@${name} has left the group.\n🌟 We wish them all the best!`,
                    mentions: [participant]
                });
            }
        }
    } catch (error) {
        console.error('Welcome/Goodbye error:', error);
    }
}

// ============================================================
// COMMAND PROCESSOR
// ============================================================

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption || '';
    
    if (!text || !text.startsWith(PREFIX)) return;
    
    const parts = text.trim().slice(PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    try {
        switch (command) {
            case 'ping':
                await handlePing(sock, from);
                break;
                
            case 'jid':
                await handleJid(sock, from, msg);
                break;
                
            case 'gjid':
                await handleGjid(sock, from);
                break;
                
            case 'menu':
            case 'help':
                await handleMenu(sock, from);
                break;
                
            case 'status':
                await handleStatus(sock, from);
                break;
                
            case 'forward':
                await handleForward(sock, msg, args);
                break;
                
            case 'caption':
                await handleCaption(sock, msg, args);
                break;
                
            case 'kick':
                await handleKick(sock, msg, args);
                break;
                
            case 'add':
                await handleAdd(sock, msg, args);
                break;
                
            case 'promote':
                await handlePromote(sock, msg, args);
                break;
                
            case 'demote':
                await handleDemote(sock, msg, args);
                break;
                
            case 'antidel':
            case 'autodel':
            case 'antipromote':
            case 'antidemote':
            case 'welcome':
            case 'goodbye':
                await handleToggle(sock, from, command, args[0]);
                break;
                
            default:
                // Unknown command
                break;
        }
    } catch (error) {
        console.error('Command error:', error);
        await sock.sendMessage(from, { 
            text: `❌ Error: ${error.message}` 
        });
    }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} already connected.`);
            return;
        }
        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }
    
    console.log(`🚀 Starting session: ${sessionId}`);
    
    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null
    };
    sessions.set(sessionId, sessionState);
    
    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;
    
    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
            console.log(`📱 QR generated for ${sessionId}`);
        }
        
        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;
            
            if (statusCode !== DisconnectReason.loggedOut && statusCode !== 440) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                console.log(`Session ${sessionId} logged out.`);
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected`);
        }
    });
    
    wasi_sock.ev.on('creds.update', saveCreds);
    
    // Message Handler
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;
        
        const from = wasi_msg.key.remoteJid;
        const text = wasi_msg.message.conversation ||
                    wasi_msg.message.extendedTextMessage?.text ||
                    wasi_msg.message.imageMessage?.caption ||
                    wasi_msg.message.videoMessage?.caption || '';
        
        // Process commands
        if (text.startsWith(PREFIX)) {
            await processCommand(wasi_sock, wasi_msg);
        }
        
        // Auto Forward
        if (settings.autoForward && SOURCE_JIDS.includes(from) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message);
                if (!relayMsg) return;
                
                // Handle view once
                if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;
                
                const isMedia = relayMsg.imageMessage || relayMsg.videoMessage || 
                               relayMsg.audioMessage || relayMsg.documentMessage || 
                               relayMsg.stickerMessage;
                
                let isEmojiOnly = false;
                if (relayMsg.conversation) {
                    const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u;
                    isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                }
                
                if (!isMedia && !isEmojiOnly) return;
                
                // Replace captions
                if (relayMsg.imageMessage?.caption) {
                    relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                }
                if (relayMsg.videoMessage?.caption) {
                    relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                }
                if (relayMsg.documentMessage?.caption) {
                    relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                }
                
                for (const target of TARGET_JIDS) {
                    await wasi_sock.relayMessage(target, relayMsg, {
                        messageId: wasi_sock.generateMessageTag()
                    });
                }
                console.log(`📦 Auto-forwarded from ${from}`);
            } catch (err) {
                console.error('Auto-forward error:', err.message);
            }
        }
        
        // Anti-Link
        await handleAntiLink(wasi_sock, wasi_msg);
    });
    
    // Anti-Delete
    wasi_sock.ev.on('messages.delete', async (deleteData) => {
        await handleAntiDelete(wasi_sock, deleteData);
    });
    
    // Group Updates
    wasi_sock.ev.on('group-participants.update', async (update) => {
        await handleAntiPromoteDemote(wasi_sock, update);
        await handleWelcomeGoodbye(wasi_sock, update);
    });
}

// ============================================================
// EXPRESS APIs
// ============================================================

wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);
    
    let qrDataUrl = null;
    if (session?.qr) {
        try {
            qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
        } catch (e) {}
    }
    
    res.json({
        success: true,
        sessionId,
        connected: session?.isConnected || false,
        qr: qrDataUrl,
        owner: BOT_OWNER,
        prefix: PREFIX,
        settings,
        uptime: process.uptime(),
        sessions: Array.from(sessions.keys()),
        timestamp: new Date().toISOString()
    });
});

wasi_app.post('/api/restart', async (req, res) => {
    try {
        for (const [sid, session] of sessions) {
            if (session.sock) {
                try { session.sock.end(undefined); } catch (e) {}
            }
        }
        sessions.clear();
        setTimeout(() => main(), 1000);
        res.json({ success: true, message: 'Restarting...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        if (session?.sock) {
            try { await session.sock.logout(); } catch (e) {}
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        res.json({ success: true, message: 'Logged out' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.get('/api/sessions', async (req, res) => {
    const list = Array.from(sessions.keys()).map(id => ({
        sessionId: id,
        isConnected: sessions.get(id)?.isConnected || false
    }));
    res.json({ success: true, sessions: list, total: list.length });
});

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        settings
    });
});

wasi_app.post('/api/settings', async (req, res) => {
    try {
        const { feature, status } = req.body;
        const featureMap = {
            'antidel': 'antiDelete',
            'autodel': 'autoDeleteLink',
            'antipromote': 'antiPromote',
            'antidemote': 'antiDemote',
            'welcome': 'welcomeMessage',
            'goodbye': 'goodbyeMessage'
        };
        
        const key = featureMap[feature];
        if (!key) {
            return res.status(400).json({ success: false, error: 'Invalid feature' });
        }
        
        settings[key] = status === 'on';
        fs.writeFileSync(path.join(__dirname, 'botConfig.json'), 
            JSON.stringify({ settings }, null, 2));
        
        res.json({ success: true, message: `${feature} set to ${status}`, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// SERVER START
// ============================================================

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`
╔═══════════════════════════════════════╗
║     🤖 WHATSAPP BOT STARTED          ║
╠═══════════════════════════════════════╣
║  📱 Port: ${wasi_port}                         ║
║  👑 Owner: ${BOT_OWNER}           ║
║  🔤 Prefix: ${PREFIX}                           ║
║  📦 Auto-Forward: ${settings.autoForward ? 'ON' : 'OFF'}              ║
║  🛡️ Anti-Delete: ${settings.antiDelete ? 'ON' : 'OFF'}               ║
║  🔗 Auto-Delete Links: ${settings.autoDeleteLink ? 'ON' : 'OFF'}           ║
║  🛡️ Anti-Promote: ${settings.antiPromote ? 'ON' : 'OFF'}              ║
║  🛡️ Anti-Demote: ${settings.antiDemote ? 'ON' : 'OFF'}               ║
║  👋 Welcome: ${settings.welcomeMessage ? 'ON' : 'OFF'}                ║
║  👋 Goodbye: ${settings.goodbyeMessage ? 'ON' : 'OFF'}                ║
╠═══════════════════════════════════════╣
║  📌 Commands:                       ║
║  ${PREFIX}menu - Show all commands  ║
║  ${PREFIX}status - Bot status       ║
╠═══════════════════════════════════════╣
║  🌐 API: http://localhost:${wasi_port}/api/status ║
╚═══════════════════════════════════════╝
        `);
    });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    // Connect Database
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) console.log('✅ Database connected');
    }
    
    // Start session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);
    
    // Start server
    wasi_startServer();
}

main();
