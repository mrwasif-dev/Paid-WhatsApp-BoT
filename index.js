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

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

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

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// CONFIGURATION WITH TOGGLES
// -----------------------------------------------------------------------------
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

// Toggle settings (can be changed via commands)
let settings = {
    antiDelete: true,      // Anti-Delete on/off
    autoDeleteLink: true,  // Auto delete links on/off
    antiPromote: true,     // Anti-Promote on/off
    antiDemote: true,      // Anti-Demote on/off
    welcomeMessage: true,  // Welcome message on/off
    goodbyeMessage: true,  // Goodbye message on/off
};

// Owner JID (the bot owner)
const OWNER_JID = process.env.OWNER_JID || '923001234567@s.whatsapp.net';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

/**
 * Clean forwarded label from message
 */
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.audioMessage?.contextInfo) {
            cleanedMessage.audioMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.audioMessage.contextInfo.forwardingScore) {
                cleanedMessage.audioMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.documentMessage?.contextInfo) {
            cleanedMessage.documentMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.documentMessage.contextInfo.forwardingScore) {
                cleanedMessage.documentMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.protocolMessage) {
            if (cleanedMessage.protocolMessage.type === 14 || 
                cleanedMessage.protocolMessage.type === 26) {
                if (cleanedMessage.protocolMessage.historySyncNotification) {
                    const syncData = cleanedMessage.protocolMessage.historySyncNotification;
                    if (syncData.pushName) {
                        console.log('Newsletter from:', syncData.pushName);
                    }
                }
            }
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
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    cleanedText = cleanedText.trim();
    return cleanedText;
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
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
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
        
        delete cleanedMessage.protocolMessage;
        
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        if (cleanedMessage.extendedTextMessage) {
            cleanedMessage.extendedTextMessage.contextInfo = cleanedMessage.extendedTextMessage.contextInfo || {};
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            let groupType = "Simple Group";
            if (group.isCommunity) {
                groupType = "Community";
            } else if (group.isCommunityAnnounce) {
                groupType = "Community Announcement";
            } else if (group.parentGroup) {
                groupType = "Subgroup";
            }
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   📝 Type: ${groupType}\n`;
            response += `   ──────────────\n\n`;
            
            groupCount++;
        }
        
        if (groupCount === 1) {
            response = "❌ No groups found. You are not in any groups.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }
        
        await sock.sendMessage(from, { text: response });
        console.log(`GJID command executed. Sent ${groupCount - 1} groups list.`);
        
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { 
            text: "❌ Error fetching groups list. Please try again later." 
        });
    }
}

/**
 * Handle !forward command
 */
async function handleForwardCommand(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    // Check if message is a reply
    if (!msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
        await sock.sendMessage(from, { 
            text: "❌ Please reply to a message you want to forward!" 
        });
        return;
    }
    
    // Get target JID from command
    const targetJid = args[0];
    if (!targetJid || !targetJid.includes('@s.whatsapp.net')) {
        await sock.sendMessage(from, { 
            text: "❌ Please provide a valid JID!\nExample: `!forward 923001234567@s.whatsapp.net`" 
        });
        return;
    }
    
    try {
        // Get the replied message
        const quotedMsg = msg.message.extendedTextMessage.contextInfo;
        const msgId = quotedMsg.stanzaId;
        const participant = quotedMsg.participant || from;
        
        // Fetch the actual message (you need to implement this based on your message store)
        // For now, we'll use the quoted message directly
        const cleanedMsg = processAndCleanMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage);
        
        if (!cleanedMsg) {
            await sock.sendMessage(from, { text: "❌ Could not process the message!" });
            return;
        }
        
        // Forward the cleaned message
        await sock.relayMessage(
            targetJid,
            cleanedMsg,
            { messageId: sock.generateMessageTag() }
        );
        
        await sock.sendMessage(from, { 
            text: `✅ Message forwarded successfully to ${targetJid}` 
        });
        console.log(`📤 Forwarded message to ${targetJid}`);
        
    } catch (error) {
        console.error('Forward command error:', error);
        await sock.sendMessage(from, { 
            text: `❌ Error forwarding message: ${error.message}` 
        });
    }
}

/**
 * Handle !caption command
 */
async function handleCaptionCommand(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    // Check if message is a reply
    if (!msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
        await sock.sendMessage(from, { 
            text: "❌ Please reply to a media message to change its caption!" 
        });
        return;
    }
    
    const newCaption = args.join(' ');
    if (!newCaption) {
        await sock.sendMessage(from, { 
            text: "❌ Please provide a new caption!\nExample: `!caption This is my new caption`" 
        });
        return;
    }
    
    try {
        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
        
        // Check if it's a media message
        const mediaType = Object.keys(quotedMsg).find(key => 
            ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(key)
        );
        
        if (!mediaType) {
            await sock.sendMessage(from, { 
                text: "❌ Please reply to a media message (image, video, document, or audio)!" 
            });
            return;
        }
        
        // Get media data
        const mediaMsg = quotedMsg[mediaType];
        const mediaUrl = await sock.downloadMediaMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage);
        
        // Prepare media message with new caption
        const mediaOptions = {
            caption: newCaption,
            mimetype: mediaMsg.mimetype,
            fileLength: mediaMsg.fileLength,
        };
        
        // Send media with new caption
        await sock.sendMessage(from, {
            [mediaType.replace('Message', '')]: mediaUrl,
            ...mediaOptions
        });
        
        await sock.sendMessage(from, { 
            text: `✅ Caption updated successfully!\n\n📝 New Caption: ${newCaption}` 
        });
        console.log(`📝 Caption updated for media in ${from}`);
        
    } catch (error) {
        console.error('Caption command error:', error);
        await sock.sendMessage(from, { 
            text: `❌ Error updating caption: ${error.message}` 
        });
    }
}

/**
 * Handle !kick command
 */
async function handleKickCommand(sock, msg, args) {
    const from = msg.key.remoteJid;
    
    // Check if it's a group
    if (!from.includes('g.us')) {
        await sock.sendMessage(from, { 
            text: "❌ This command can only be used in groups!" 
        });
        return;
    }
    
    // Check if user is admin
    const groupMetadata = await sock.groupMetadata(from);
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const sender = groupMetadata.participants.find(p => p.id === senderJid);
    
    if (!sender || !sender.admin) {
        await sock.sendMessage(from, { 
            text: "❌ Only admins can use this command!" 
        });
        return;
    }
    
    // Check if bot is admin
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const bot = groupMetadata.participants.find(p => p.id === botJid);
    if (!bot || !bot.admin) {
        await sock.sendMessage(from, { 
            text: "❌ Bot must be an admin to kick members!" 
        });
        return;
    }
    
    // Get target user
    let targetJid = null;
    
    // Check if replying to a message
    if (msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
        const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
        if (quotedMsg) {
            targetJid = msg.message.extendedTextMessage.contextInfo.participant || 
                       msg.message.extendedTextMessage.contextInfo.remoteJid;
        }
    }
    
    // Check if mentioned
    if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid) {
        targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
    }
    
    // Check if provided as argument
    if (!targetJid && args.length > 0) {
        targetJid = args[0].replace('@', '');
        if (!targetJid.includes('@s.whatsapp.net')) {
            targetJid = targetJid + '@s.whatsapp.net';
        }
    }
    
    if (!targetJid) {
        await sock.sendMessage(from, { 
            text: "❌ Please tag, reply, or provide a JID to kick!\nExample: `!kick @user` or reply to a message" 
        });
        return;
    }
    
    // Prevent kicking bot itself
    if (targetJid === botJid) {
        await sock.sendMessage(from, { 
            text: "❌ I can't kick myself!" 
        });
        return;
    }
    
    // Prevent kicking owner
    if (targetJid === OWNER_JID) {
        await sock.sendMessage(from, { 
            text: "❌ You cannot kick the bot owner!" 
        });
        return;
    }
    
    try {
        await sock.groupParticipantsUpdate(from, [targetJid], 'remove');
        
        const targetName = groupMetadata.participants.find(p => p.id === targetJid)?.name || targetJid;
        await sock.sendMessage(from, { 
            text: `✅ *${targetName}* has been kicked from the group!` 
        });
        console.log(`👢 Kicked ${targetJid} from ${from}`);
        
    } catch (error) {
        console.error('Kick command error:', error);
        await sock.sendMessage(from, { 
            text: `❌ Error kicking member: ${error.message}` 
        });
    }
}

/**
 * Handle toggle commands
 */
async function handleToggleCommand(sock, from, feature, status) {
    if (status !== 'on' && status !== 'off') {
        await sock.sendMessage(from, {
            text: `❌ Invalid status! Use \`on\` or \`off\`\nExample: \`!${feature} on\``
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
            text: `❌ Unknown feature! Available: antidel, autodel, antipromote, antidemote, welcome, goodbye`
        });
        return;
    }
    
    settings[key] = status === 'on';
    
    // Save to config file
    try {
        fs.writeFileSync(
            path.join(__dirname, 'botConfig.json'),
            JSON.stringify({ settings }, null, 2)
        );
    } catch (e) {
        console.error('Error saving settings:', e);
    }
    
    await sock.sendMessage(from, {
        text: `✅ *${feature}* is now ${status.toUpperCase()}!`
    });
    console.log(`🔘 ${feature} toggled ${status}`);
}

// -----------------------------------------------------------------------------
// ANTI-DELETE HANDLER
// -----------------------------------------------------------------------------

async function handleAntiDelete(sock, deleteData) {
    if (!settings.antiDelete) return;
    
    try {
        const { keys, jid } = deleteData;
        
        // Only work in groups
        if (!jid.includes('g.us')) return;
        
        for (const key of keys) {
            // Skip if deleted by bot itself
            if (key.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net') continue;
            
            // Get the deleted message info
            const deletedMsg = key.message;
            if (!deletedMsg) continue;
            
            // Get sender info
            const senderJid = key.participant || key.remoteJid;
            
            // Get group info
            const groupMetadata = await sock.groupMetadata(jid);
            const groupName = groupMetadata.subject || 'Unknown Group';
            const senderName = groupMetadata.participants.find(p => p.id === senderJid)?.name || senderJid;
            
            // Prepare info message
            let infoMessage = `🔴 *Message Deleted!*\n\n`;
            infoMessage += `📌 *Group:* ${groupName}\n`;
            infoMessage += `👤 *Deleted By:* ${senderName}\n`;
            infoMessage += `🆔 *JID:* ${senderJid}\n`;
            infoMessage += `🕐 *Time:* ${new Date().toLocaleString()}\n\n`;
            infoMessage += `📝 *Deleted Message:*\n`;
            infoMessage += `────────────────────\n`;
            
            // Extract message content
            const text = deletedMsg.conversation ||
                        deletedMsg.extendedTextMessage?.text ||
                        deletedMsg.imageMessage?.caption ||
                        deletedMsg.videoMessage?.caption ||
                        deletedMsg.documentMessage?.caption ||
                        '(Media Message)';
            
            infoMessage += `${text}\n`;
            infoMessage += `────────────────────\n\n`;
            infoMessage += `🔒 *Saved to DM*`;
            
            // Send to DM (owner)
            await sock.sendMessage(OWNER_JID, { text: infoMessage });
            console.log(`🔴 Anti-Delete: Message from ${senderJid} deleted in ${jid}`);
        }
        
    } catch (error) {
        console.error('Anti-Delete error:', error);
    }
}

// -----------------------------------------------------------------------------
// ANTI-LINK HANDLER
// -----------------------------------------------------------------------------

async function handleAntiLink(sock, msg) {
    if (!settings.autoDeleteLink) return;
    
    try {
        const from = msg.key.remoteJid;
        
        // Only work in groups
        if (!from.includes('g.us')) return;
        
        const text = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    '';
        
        // URL pattern
        const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi;
        
        if (urlPattern.test(text)) {
            // Check if sender is admin or owner
            const groupMetadata = await sock.groupMetadata(from);
            const senderJid = msg.key.participant || msg.key.remoteJid;
            const sender = groupMetadata.participants.find(p => p.id === senderJid);
            
            // Skip if sender is admin or owner
            if (sender?.admin || senderJid === OWNER_JID) {
                console.log(`🔗 Link allowed for admin/owner: ${senderJid}`);
                return;
            }
            
            // Delete the message
            await sock.sendMessage(from, {
                delete: msg.key
            });
            
            console.log(`🔗 Auto-deleted link from ${senderJid} in ${from}`);
        }
        
    } catch (error) {
        console.error('Anti-Link error:', error);
    }
}

// -----------------------------------------------------------------------------
// ANTI-PROMOTE/DEMOTE HANDLER
// -----------------------------------------------------------------------------

async function handleAntiPromoteDemote(sock, update) {
    try {
        // Check if it's a group update
        if (!update.participants) return;
        
        const { jid, participants, action } = update;
        
        // Only work in groups
        if (!jid.includes('g.us')) return;
        
        // Check if feature is enabled
        if (action === 'promote' && !settings.antiPromote) return;
        if (action === 'demote' && !settings.antiDemote) return;
        
        // Get the person who did the action
        const actorJid = update.actor || update.participant;
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        
        // Skip if bot itself did the action
        if (actorJid === botJid) return;
        
        // Skip if owner did the action
        if (actorJid === OWNER_JID) return;
        
        // Get group metadata
        const groupMetadata = await sock.groupMetadata(jid);
        const groupName = groupMetadata.subject || 'Unknown Group';
        
        // Get actor name
        const actor = groupMetadata.participants.find(p => p.id === actorJid);
        const actorName = actor?.name || actorJid;
        
        for (const participant of participants) {
            const target = groupMetadata.participants.find(p => p.id === participant);
            const targetName = target?.name || participant;
            
            // Reverse the action
            const reverseAction = action === 'promote' ? 'demote' : 'promote';
            await sock.groupParticipantsUpdate(jid, [participant], reverseAction);
            
            // Send info message in group
            let infoMessage = `🚨 *Anti-${action === 'promote' ? 'Promote' : 'Demote'} Action!*\n\n`;
            infoMessage += `❌ *Attempted by:* ${actorName}\n`;
            infoMessage += `👤 *Target:* ${targetName}\n`;
            infoMessage += `📌 *Group:* ${groupName}\n`;
            infoMessage += `🕐 *Time:* ${new Date().toLocaleString()}\n\n`;
            infoMessage += `⚠️ Only the bot owner can ${action === 'promote' ? 'promote' : 'demote'} members!\n`;
            infoMessage += `🔒 Action has been reversed.`;
            
            await sock.sendMessage(jid, { text: infoMessage });
            
            // Send to DM (owner)
            await sock.sendMessage(OWNER_JID, { text: infoMessage });
            
            console.log(`🛑 ${action} prevented: ${participant} by ${actorJid} in ${jid}`);
        }
        
    } catch (error) {
        console.error('Anti-Promote/Demote error:', error);
    }
}

// -----------------------------------------------------------------------------
// WELCOME & GOODBYE HANDLER
// -----------------------------------------------------------------------------

async function handleWelcomeGoodbye(sock, update) {
    try {
        if (!update.participants) return;
        
        const { jid, participants, action } = update;
        
        // Only work in groups
        if (!jid.includes('g.us')) return;
        
        const groupMetadata = await sock.groupMetadata(jid);
        const groupName = groupMetadata.subject || 'Unknown Group';
        
        if (action === 'add' && settings.welcomeMessage) {
            for (const participant of participants) {
                const contact = await sock.sendMessage(jid, {
                    text: `👋 *Welcome to ${groupName}!*\n\n` +
                          `Hello @${participant.split('@')[0]}!\n` +
                          `We're glad to have you here. Please read the group rules and enjoy!\n\n` +
                          `📌 *Group Rules:*\n` +
                          `• No spam\n` +
                          `• No inappropriate content\n` +
                          `• Be respectful to others\n` +
                          `• Have fun! 🎉`,
                    mentions: [participant]
                });
                console.log(`👋 Welcome message sent to ${participant}`);
            }
        }
        
        if (action === 'remove' && settings.goodbyeMessage) {
            for (const participant of participants) {
                await sock.sendMessage(jid, {
                    text: `👋 *Goodbye!*\n\n` +
                          `Member @${participant.split('@')[0]} has left the group.\n` +
                          `We wish them all the best! 🌟`,
                    mentions: [participant]
                });
                console.log(`👋 Goodbye message sent for ${participant}`);
            }
        }
        
    } catch (error) {
        console.error('Welcome/Goodbye error:', error);
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
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
        qr: null,
        reconnectAttempts: 0,
    };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;

    // Register event listeners
    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
            console.log(`QR generated for session: ${sessionId}`);
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            console.log(`Session ${sessionId}: Connection closed, reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => {
                    startSession(sessionId);
                }, 3000);
            } else {
                console.log(`Session ${sessionId} logged out. Removing.`);
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Register all handlers
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // COMMAND HANDLER
        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg);
        }

        // AUTO FORWARD LOGIC
        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message);
                
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2)
                    relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage)
                    relayMsg = relayMsg.viewOnceMessage.message;

                const isMedia = relayMsg.imageMessage ||
                    relayMsg.videoMessage ||
                    relayMsg.audioMessage ||
                    relayMsg.documentMessage ||
                    relayMsg.stickerMessage;

                let isEmojiOnly = false;
                if (relayMsg.conversation) {
                    const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u;
                    isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                }

                if (!isMedia && !isEmojiOnly) return;

                if (relayMsg.imageMessage?.caption) {
                    relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                }
                if (relayMsg.videoMessage?.caption) {
                    relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                }
                if (relayMsg.documentMessage?.caption) {
                    relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                }

                console.log(`📦 Forwarding (cleaned) from ${wasi_origin}`);

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Clean message forwarded to ${targetJid}`);
                    } catch (err) {
                        console.error(`Failed to forward to ${targetJid}:`, err.message);
                    }
                }

            } catch (err) {
                console.error('Auto Forward Error:', err.message);
            }
        }
        
        // Anti-Link Check
        await handleAntiLink(wasi_sock, wasi_msg);
    });

    // Anti-Delete Handler
    wasi_sock.ev.on('messages.delete', async (deleteData) => {
        await handleAntiDelete(wasi_sock, deleteData);
    });

    // Group Update Handler (Promote/Demote & Welcome/Goodbye)
    wasi_sock.ev.on('group-participants.update', async (update) => {
        await handleAntiPromoteDemote(wasi_sock, update);
        await handleWelcomeGoodbye(wasi_sock, update);
    });
}

// -----------------------------------------------------------------------------
// COMMAND PROCESSOR
// -----------------------------------------------------------------------------

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    try {
        switch (command) {
            case '!ping':
                await handlePingCommand(sock, from);
                break;
                
            case '!jid':
                await handleJidCommand(sock, from);
                break;
                
            case '!gjid':
                await handleGjidCommand(sock, from);
                break;
                
            case '!forward':
                await handleForwardCommand(sock, msg, args);
                break;
                
            case '!caption':
                await handleCaptionCommand(sock, msg, args);
                break;
                
            case '!kick':
                await handleKickCommand(sock, msg, args);
                break;
                
            case '!antidel':
            case '!autodel':
            case '!antipromote':
            case '!antidemote':
            case '!welcome':
            case '!goodbye':
                await handleToggleCommand(sock, from, command.substring(1), args[0]);
                break;
                
            default:
                // Unknown command - ignore
                break;
        }
    } catch (error) {
        console.error('Command execution error:', error);
        await sock.sendMessage(from, { 
            text: `❌ Error executing command: ${error.message}` 
        });
    }
}

// ============================================================
// 🚀 ALL APIS
// ============================================================

// Status API
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = false;

    if (config.mongoDbUrl) {
        try {
            dbConnected = true;
        } catch (e) {
            dbConnected = false;
        }
    }

    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        phoneNumber: connected ? 'Connected ✅' : '-',
        lastActive: new Date().toISOString(),
        activeSessions: Array.from(sessions.keys()),
        settings: settings
    });
});

// Restart API
wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        
        for (const [sessionId, session] of sessions) {
            if (session.sock) {
                try {
                    session.sock.end(undefined);
                } catch (e) {
                    console.error(`Error ending session ${sessionId}:`, e);
                }
            }
        }
        sessions.clear();
        
        setTimeout(() => {
            main().catch(err => console.error('Restart error:', err));
        }, 1000);
        
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Logout API
wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sessions List API
wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health Check API
wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        settings: settings
    });
});

// Settings Update API
wasi_app.post('/api/settings', async (req, res) => {
    try {
        const { feature, status } = req.body;
        
        if (!feature || !status) {
            return res.status(400).json({ 
                success: false, 
                error: 'Feature and status are required' 
            });
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
            return res.status(400).json({
                success: false,
                error: 'Invalid feature name'
            });
        }
        
        settings[key] = status === 'on';
        
        // Save to config file
        fs.writeFileSync(
            path.join(__dirname, 'botConfig.json'),
            JSON.stringify({ settings }, null, 2)
        );
        
        res.json({
            success: true,
            message: `${feature} set to ${status}`,
            settings: settings
        });
        
    } catch (error) {
        console.error('Settings update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// SERVER START
// ============================================================

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid, !forward, !caption, !kick`);
        console.log(`🔘 Toggle Commands: !antidel, !autodel, !antipromote, !antidemote, !welcome, !goodbye`);
        console.log(`🛡️ Anti-Delete: ${settings.antiDelete ? 'ON' : 'OFF'}`);
        console.log(`🔗 Auto-Delete Links: ${settings.autoDeleteLink ? 'ON' : 'OFF'}`);
        console.log(`🛡️ Anti-Promote: ${settings.antiPromote ? 'ON' : 'OFF'}`);
        console.log(`🛡️ Anti-Demote: ${settings.antiDemote ? 'ON' : 'OFF'}`);
        console.log(`👋 Welcome Message: ${settings.welcomeMessage ? 'ON' : 'OFF'}`);
        console.log(`👋 Goodbye Message: ${settings.goodbyeMessage ? 'ON' : 'OFF'}`);
        console.log(`👑 Owner JID: ${OWNER_JID}`);
        console.log(`\n📌 API Endpoints:`);
        console.log(`   GET  /api/status     - Get bot status`);
        console.log(`   POST /api/restart    - Restart bot`);
        console.log(`   POST /api/logout     - Logout bot`);
        console.log(`   GET  /api/sessions   - List all sessions`);
        console.log(`   GET  /api/health     - Health check`);
        console.log(`   POST /api/settings   - Update settings`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------

async function main() {
    // Load saved settings
    try {
        if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
            const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
            if (savedConfig.settings) {
                settings = { ...settings, ...savedConfig.settings };
            }
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }

    // Connect DB if configured
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    // Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // Start server
    wasi_startServer();
}

main();
