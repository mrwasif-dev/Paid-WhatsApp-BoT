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
const { Telegraf } = require('telegraf');
const axios = require('axios');
const { promisify } = require('util');
const stream = require('stream');
const finished = promisify(stream.finished);

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
// TELEGRAM BOT SETUP
// -----------------------------------------------------------------------------
let telegramBot = null;
let telegramEnabled = process.env.TELEGRAM_ENABLED === 'true' || false;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramAllowedChats = process.env.TELEGRAM_ALLOWED_CHATS ? 
    process.env.TELEGRAM_ALLOWED_CHATS.split(',').map(id => id.trim()) : [];
let telegramTargetJids = process.env.TELEGRAM_TARGET_JIDS ?
    process.env.TELEGRAM_TARGET_JIDS.split(',').map(jid => jid.trim()) : [];

// Create temp directory for Telegram downloads
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

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
// PATTERN-BASED AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
const PATTERNS = {
pattern1: {
sourceJids: process.env.PATTERN1_SOURCE_JIDS
? process.env.PATTERN1_SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern1?.sourceJids || []),
targetJids: process.env.PATTERN1_TARGET_JIDS
? process.env.PATTERN1_TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern1?.targetJids || [])
},
pattern2: {
sourceJids: process.env.PATTERN2_SOURCE_JIDS
? process.env.PATTERN2_SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern2?.sourceJids || []),
targetJids: process.env.PATTERN2_TARGET_JIDS
? process.env.PATTERN2_TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern2?.targetJids || [])
},
pattern3: {
sourceJids: process.env.PATTERN3_SOURCE_JIDS
? process.env.PATTERN3_SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern3?.sourceJids || []),
targetJids: process.env.PATTERN3_TARGET_JIDS
? process.env.PATTERN3_TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern3?.targetJids || [])
},
pattern4: {
sourceJids: process.env.PATTERN4_SOURCE_JIDS
? process.env.PATTERN4_SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern4?.sourceJids || []),
targetJids: process.env.PATTERN4_TARGET_JIDS
? process.env.PATTERN4_TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern4?.targetJids || [])
},
pattern5: {
sourceJids: process.env.PATTERN5_SOURCE_JIDS
? process.env.PATTERN5_SOURCE_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern5?.sourceJids || []),
targetJids: process.env.PATTERN5_TARGET_JIDS
? process.env.PATTERN5_TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
: (config.patterns?.pattern5?.targetJids || [])
}
};

// Helper function to get target JIDs for a source JID
function getTargetJidsForSource(sourceJid) {
let targets = [];

for (const [patternName, pattern] of Object.entries(PATTERNS)) { 
    if (pattern.sourceJids.includes(sourceJid)) { 
        targets = [...targets, ...pattern.targetJids]; 
    } 
} 
return [...new Set(targets)]; // Remove duplicates 
}

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

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

/**
Clean forwarded label from message
*/
function cleanForwardedLabel(message) {
try {
// Clone the message to avoid modifying original
let cleanedMessage = JSON.parse(JSON.stringify(message));

// Remove forwarded flag from different message types 
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

// Remove newsletter/broadcast specific markers 
if (cleanedMessage.protocolMessage) { 
    if (cleanedMessage.protocolMessage.type === 14 || cleanedMessage.protocolMessage.type === 26) { 
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
Clean newsletter/information markers from text
*/
function cleanNewsletterText(text) {
if (!text) return text;

const newsletterMarkers = [
/📢\s*/g,
/🔔\s*/g,
/📰\s*/g,
/🗞️\s*/g,
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
Replace caption text using regex patterns
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
Remove links and mobile numbers from text
*/
function removeLinksAndNumbers(text) {
if (!text) return { cleaned: '', hasContent: false };

let cleanedText = text;

// Remove URLs
const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/gi;
cleanedText = cleanedText.replace(urlRegex, '');

// Remove mobile numbers (Pakistani format)
const mobileRegex = /(\+?92|0)[3-9][0-9]{2}[-\s]?[0-9]{7}|[0-9]{4}[-\s]?[0-9]{7}|[0-9]{11}/gi;
cleanedText = cleanedText.replace(mobileRegex, '');

// Remove international numbers
const intlMobileRegex = /\+\d{1,3}[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{1,9}/g;
cleanedText = cleanedText.replace(intlMobileRegex, '');

// Remove extra spaces
cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

// Check if anything meaningful remains
const hasContent = cleanedText.length > 0 && /[^\s]/.test(cleanedText);

return { cleaned: cleanedText, hasContent };
}

/**
Process and clean a message completely
*/
function processAndCleanMessage(originalMessage) {
try {
// Step 1: Clone the message
let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));

// Step 2: Remove forwarded labels 
cleanedMessage = cleanForwardedLabel(cleanedMessage); 

// Step 3: Check if media exists 
const isMedia = cleanedMessage.imageMessage || cleanedMessage.videoMessage || 
                cleanedMessage.audioMessage || cleanedMessage.documentMessage || 
                cleanedMessage.stickerMessage; 

// Step 4: Extract text and clean 
const text = cleanedMessage.conversation || 
             cleanedMessage.extendedTextMessage?.text || 
             cleanedMessage.imageMessage?.caption || 
             cleanedMessage.videoMessage?.caption || 
             cleanedMessage.documentMessage?.caption || ''; 

if (text) { 
    // First clean newsletter markers
    let cleanedText = cleanNewsletterText(text); 
    // Then remove links and mobile numbers
    const { cleaned: textAfterRemoval, hasContent } = removeLinksAndNumbers(cleanedText); 
    cleanedText = textAfterRemoval; 
    
    // If no content remains and it's not media, return null
    if (!hasContent && !isMedia) { 
        console.log('Skipping message: No content after removing links/numbers'); 
        return null; 
    } 
    
    // Update the cleaned text in appropriate field 
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

// Step 5: Remove protocol messages 
delete cleanedMessage.protocolMessage; 

// Step 6: Remove newsletter sender info 
if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) { 
    const participant = cleanedMessage.extendedTextMessage.contextInfo.participant; 
    if (participant.includes('newsletter') || participant.includes('broadcast')) { 
        delete cleanedMessage.extendedTextMessage.contextInfo.participant; 
        delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId; 
        delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid; 
    } 
} 

// Step 7: Ensure message appears as original 
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
// TELEGRAM BOT FUNCTIONS
// -----------------------------------------------------------------------------

/**
Download file from Telegram
*/
async function downloadTelegramFile(fileId, fileExt) {
    try {
        const fileLink = await telegramBot.telegram.getFileLink(fileId);
        const tempPath = path.join(tempDir, `telegram_${Date.now()}.${fileExt}`);
        
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({
            method: 'get',
            url: fileLink.href,
            responseType: 'stream'
        });

        response.data.pipe(writer);
        await finished(writer);
        
        return tempPath;
    } catch (error) {
        console.error('Error downloading Telegram file:', error);
        return null;
    }
}

/**
Check if Telegram user is authorized
*/
function isTelegramAuthorized(ctx) {
    const chatId = ctx.chat?.id?.toString();
    const fromId = ctx.from?.id?.toString();
    
    // If no allowed chats configured, allow all
    if (!telegramAllowedChats || telegramAllowedChats.length === 0) {
        return true;
    }
    
    return telegramAllowedChats.includes(chatId) || telegramAllowedChats.includes(fromId);
}

/**
Send media to WhatsApp
*/
async function sendToWhatsApp(mediaType, filePath, caption = '') {
    try {
        const session = sessions.get(config.sessionId || 'wasi_session');
        if (!session || !session.sock || !session.isConnected) {
            console.log('WhatsApp not connected');
            return false;
        }

        const sock = session.sock;
        let message = {};

        // Clean caption
        const cleanCaption = replaceCaption(cleanNewsletterText(caption));

        // Prepare message based on media type
        switch(mediaType) {
            case 'photo':
                message = {
                    image: { url: filePath },
                    caption: cleanCaption
                };
                break;
            case 'video':
                message = {
                    video: { url: filePath },
                    caption: cleanCaption
                };
                break;
            case 'document':
                message = {
                    document: { url: filePath },
                    caption: cleanCaption,
                    fileName: path.basename(filePath)
                };
                break;
            case 'audio':
                message = {
                    audio: { url: filePath },
                    ptt: false // Set to true for voice message
                };
                break;
            case 'voice':
                message = {
                    audio: { url: filePath },
                    ptt: true
                };
                break;
            default:
                message = { text: cleanCaption };
        }

        // Send to all target JIDs
        for (const targetJid of telegramTargetJids) {
            try {
                await sock.sendMessage(targetJid, message);
                console.log(`✅ Telegram media sent to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to send to ${targetJid}:`, err.message);
            }
        }

        // Clean up temp file
        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting temp file:', err);
        });

        return true;
    } catch (error) {
        console.error('Error sending to WhatsApp:', error);
        return false;
    }
}

/**
Start Telegram Bot
*/
async function startTelegramBot() {
    if (!telegramEnabled || !telegramToken) {
        console.log('⚠️ Telegram bot is disabled or token not configured');
        return;
    }

    try {
        telegramBot = new Telegraf(telegramToken);

        // Start command
        telegramBot.start((ctx) => {
            if (!isTelegramAuthorized(ctx)) {
                return ctx.reply('⛔ Unauthorized');
            }
            ctx.reply('✅ WhatsApp Bot Connected!\n\nSend me any media or message and it will be forwarded to WhatsApp.');
        });

        // Help command
        telegramBot.help((ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            ctx.reply(
                '📱 *WhatsApp Forwarder Bot*\n\n' +
                'Send me any media or message and it will be forwarded to configured WhatsApp groups/chats.\n\n' +
                'Supported formats:\n' +
                '• Photos 📸\n' +
                '• Videos 🎥\n' +
                '• Documents 📄\n' +
                '• Audio 🎵\n' +
                '• Voice Messages 🎤\n' +
                '• Text Messages 💬'
            );
        });

        // Handle text messages
        telegramBot.on('text', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const text = ctx.message.text;
            if (!telegramTargetJids.length) {
                return ctx.reply('❌ No WhatsApp targets configured');
            }

            try {
                const session = sessions.get(config.sessionId || 'wasi_session');
                if (!session || !session.sock || !session.isConnected) {
                    return ctx.reply('❌ WhatsApp not connected');
                }

                // Clean the text
                const cleanedText = cleanNewsletterText(text);
                const { cleaned: finalText, hasContent } = removeLinksAndNumbers(cleanedText);

                if (!hasContent) {
                    return ctx.reply('❌ Message has no content after cleaning');
                }

                // Send to all targets
                for (const targetJid of telegramTargetJids) {
                    await session.sock.sendMessage(targetJid, { text: finalText });
                }

                ctx.reply(`✅ Message forwarded to ${telegramTargetJids.length} WhatsApp target(s)`);
            } catch (error) {
                console.error('Error forwarding text:', error);
                ctx.reply('❌ Failed to forward message');
            }
        });

        // Handle photos
        telegramBot.on('photo', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const caption = ctx.message.caption || '';
            
            ctx.reply('📥 Downloading photo...');
            
            const filePath = await downloadTelegramFile(photo.file_id, 'jpg');
            if (filePath) {
                const success = await sendToWhatsApp('photo', filePath, caption);
                ctx.reply(success ? '✅ Photo sent to WhatsApp' : '❌ Failed to send photo');
            } else {
                ctx.reply('❌ Failed to download photo');
            }
        });

        // Handle videos
        telegramBot.on('video', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const video = ctx.message.video;
            const caption = ctx.message.caption || '';
            
            ctx.reply('📥 Downloading video...');
            
            const fileExt = video.file_name ? video.file_name.split('.').pop() : 'mp4';
            const filePath = await downloadTelegramFile(video.file_id, fileExt);
            
            if (filePath) {
                const success = await sendToWhatsApp('video', filePath, caption);
                ctx.reply(success ? '✅ Video sent to WhatsApp' : '❌ Failed to send video');
            } else {
                ctx.reply('❌ Failed to download video');
            }
        });

        // Handle documents
        telegramBot.on('document', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const document = ctx.message.document;
            const caption = ctx.message.caption || '';
            
            ctx.reply('📥 Downloading document...');
            
            const fileExt = document.file_name ? document.file_name.split('.').pop() : 'bin';
            const filePath = await downloadTelegramFile(document.file_id, fileExt);
            
            if (filePath) {
                const success = await sendToWhatsApp('document', filePath, caption);
                ctx.reply(success ? '✅ Document sent to WhatsApp' : '❌ Failed to send document');
            } else {
                ctx.reply('❌ Failed to download document');
            }
        });

        // Handle audio
        telegramBot.on('audio', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const audio = ctx.message.audio;
            const caption = ctx.message.caption || '';
            
            ctx.reply('📥 Downloading audio...');
            
            const fileExt = 'mp3';
            const filePath = await downloadTelegramFile(audio.file_id, fileExt);
            
            if (filePath) {
                const success = await sendToWhatsApp('audio', filePath, caption);
                ctx.reply(success ? '✅ Audio sent to WhatsApp' : '❌ Failed to send audio');
            } else {
                ctx.reply('❌ Failed to download audio');
            }
        });

        // Handle voice messages
        telegramBot.on('voice', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const voice = ctx.message.voice;
            
            ctx.reply('📥 Downloading voice message...');
            
            const filePath = await downloadTelegramFile(voice.file_id, 'ogg');
            
            if (filePath) {
                const success = await sendToWhatsApp('voice', filePath, '');
                ctx.reply(success ? '✅ Voice message sent to WhatsApp' : '❌ Failed to send voice message');
            } else {
                ctx.reply('❌ Failed to download voice message');
            }
        });

        // Handle stickers (convert to image)
        telegramBot.on('sticker', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            
            const sticker = ctx.message.sticker;
            
            ctx.reply('📥 Downloading sticker...');
            
            const fileExt = sticker.is_animated ? 'tgs' : 'webp';
            const filePath = await downloadTelegramFile(sticker.file_id, fileExt);
            
            if (filePath) {
                const session = sessions.get(config.sessionId || 'wasi_session');
                if (session && session.sock && session.isConnected) {
                    for (const targetJid of telegramTargetJids) {
                        await session.sock.sendMessage(targetJid, { 
                            sticker: { url: filePath } 
                        });
                    }
                    ctx.reply('✅ Sticker sent to WhatsApp');
                }
                // Clean up
                fs.unlink(filePath, () => {});
            } else {
                ctx.reply('❌ Failed to download sticker');
            }
        });

        // Handle errors
        telegramBot.catch((err, ctx) => {
            console.error('Telegram bot error:', err);
            ctx.reply('❌ An error occurred').catch(() => {});
        });

        // Launch bot
        await telegramBot.launch();
        console.log('🤖 Telegram bot started successfully');
        console.log(`📱 Allowed chats: ${telegramAllowedChats.length ? telegramAllowedChats.join(', ') : 'All'}`);
        console.log(`🎯 WhatsApp targets: ${telegramTargetJids.length ? telegramTargetJids.join(', ') : 'None'}`);

        // Enable graceful stop
        process.once('SIGINT', () => telegramBot.stop('SIGINT'));
        process.once('SIGTERM', () => telegramBot.stop('SIGTERM'));

    } catch (error) {
        console.error('Failed to start Telegram bot:', error);
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
const messages = [
"Janu 🥹",
"Love 😘 You",
"Do You Love Me 🥹",
"Please 🥺",
"🙃🙂"
];

for (const msg of messages) { 
    await sock.sendMessage(from, { text: msg }); 
    await new Promise(resolve => setTimeout(resolve, 100)); 
} 
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
    response += ` 👥 Members: ${participantsCount}\n`; 
    response += ` 🆔: \`${jid}\`\n`; 
    response += ` 📝 Type: ${groupType}\n`; 
    response += ` ──────────────\n\n`; 
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
await sock.sendMessage(from, { text: "❌ Error fetching groups list. Please try again later." }); 
} 
}

async function processCommand(sock, msg) {
const from = msg.key.remoteJid;
const text = msg.message.conversation ||
msg.message.extendedTextMessage?.text ||
msg.message.imageMessage?.caption ||
msg.message.videoMessage?.caption ||
"";

if (!text || !text.startsWith('!')) return; 

const command = text.trim().toLowerCase(); 

try { 
    if (command === '!ping') { 
        await handlePingCommand(sock, from); 
    } else if (command === '!jid') { 
        await handleJidCommand(sock, from); 
    } else if (command === '!gjid') { 
        await handleGjidCommand(sock, from); 
    } 
} catch (error) { 
    console.error('Command execution error:', error); 
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

wasi_sock.ev.on('connection.update', async (update) => { 
const { connection, lastDisconnect, qr } = update; 

if (qr) { 
    sessionState.qr = qr; 
    sessionState.isConnected = false; 
    console.log(`QR generated for session: ${sessionId}`); 
} 

if (connection === 'close') { 
    sessionState.isConnected = false; 
    const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500; 
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
    
    // Start Telegram bot when WhatsApp is connected
    if (telegramEnabled && telegramToken && !telegramBot) {
        await startTelegramBot();
    }
} 
}); 

wasi_sock.ev.on('creds.update', saveCreds); 

// AUTO FORWARD MESSAGE HANDLER
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
const targetsForThisSource = getTargetJidsForSource(wasi_origin); 
if (targetsForThisSource.length > 0 && !wasi_msg.key.fromMe) { 
    try { 
        // Process and clean the message 
        let relayMsg = processAndCleanMessage(wasi_msg.message); 
        if (!relayMsg) return; 

        // View Once Unwrap 
        if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message; 
        if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message; 

        // Check for Media or Emoji Only 
        const isMedia = relayMsg.imageMessage || relayMsg.videoMessage || 
                       relayMsg.audioMessage || relayMsg.documentMessage || 
                       relayMsg.stickerMessage; 
        let isEmojiOnly = false; 
        if (relayMsg.conversation) { 
            const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u; 
            isEmojiOnly = emojiRegex.test(relayMsg.conversation); 
        } 

        // Only forward if media or emoji 
        if (!isMedia && !isEmojiOnly) return; 

        // Apply caption replacement 
        if (relayMsg.imageMessage?.caption) { 
            relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption); 
        } 
        if (relayMsg.videoMessage?.caption) { 
            relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption); 
        } 
        if (relayMsg.documentMessage?.caption) { 
            relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption); 
        } 

        console.log(`📦 Forwarding from ${wasi_origin} using pattern(s)`); 

        // Forward to all target JIDs for this source 
        for (const targetJid of targetsForThisSource) { 
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
}); 
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
const session = sessions.get(sessionId);

let qrDataUrl = null; 
let connected = false; 

if (session) { 
    connected = session.isConnected; 
    if (session.qr) { 
        try { 
            qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 }); 
        } catch (e) {} 
    } 
} 

// Calculate pattern statistics
let totalSources = 0; 
let totalTargets = 0; 
const patternsStatus = {}; 

for (const [patternName, pattern] of Object.entries(PATTERNS)) { 
    patternsStatus[patternName] = { 
        sources: pattern.sourceJids.length, 
        targets: pattern.targetJids.length, 
        active: pattern.sourceJids.length > 0 && pattern.targetJids.length > 0 
    }; 
    totalSources += pattern.sourceJids.length; 
    totalTargets += pattern.targetJids.length; 
} 

res.json({ 
    sessionId, 
    connected, 
    qr: qrDataUrl, 
    activeSessions: Array.from(sessions.keys()),
    telegram: {
        enabled: telegramEnabled,
        botRunning: telegramBot !== null,
        allowedChats: telegramAllowedChats,
        targetJids: telegramTargetJids
    },
    patterns: patternsStatus, 
    totalSources, 
    totalTargets, 
    messageCleaning: { 
        removeForwardedLabel: true, 
        removeNewsletterMarkers: true, 
        removeLinksAndNumbers: true, 
        captionReplacement: OLD_TEXT_REGEX.length > 0 
    } 
}); 
});

wasi_app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
wasi_app.listen(wasi_port, () => {
console.log(`🌐 Server running on port ${wasi_port}`);

// Show pattern configuration 
console.log(`📡 Pattern Configuration:`); 
let activePatterns = 0; 
for (const [patternName, pattern] of Object.entries(PATTERNS)) { 
    if (pattern.sourceJids.length > 0 && pattern.targetJids.length > 0) { 
        console.log(` ✅ ${patternName}: ${pattern.sourceJids.length} source(s) → ${pattern.targetJids.length} target(s)`); 
        activePatterns++; 
    } else if (pattern.sourceJids.length > 0 || pattern.targetJids.length > 0) { 
        console.log(` ⚠️ ${patternName}: ${pattern.sourceJids.length} source(s) → ${pattern.targetJids.length} target(s) (incomplete)`); 
    } 
} 

if (activePatterns === 0) { 
    console.log(` ❌ No active patterns configured`); 
} 

// Show Telegram configuration
console.log(`\n🤖 Telegram Bot:`);
console.log(` • Enabled: ${telegramEnabled ? '✅' : '❌'}`);
if (telegramEnabled) {
    console.log(` • Token configured: ${telegramToken ? '✅' : '❌'}`);
    console.log(` • Allowed chats: ${telegramAllowedChats.length ? telegramAllowedChats.join(', ') : 'All'}`);
    console.log(` • WhatsApp targets: ${telegramTargetJids.length ? telegramTargetJids.join(', ') : 'None'}`);
}

console.log(`\n✨ Message Cleaning:`); 
console.log(` • Forwarded labels removed`); 
console.log(` • Newsletter markers cleaned`); 
console.log(` • Links and mobile numbers removed`); 
if (OLD_TEXT_REGEX.length > 0) { 
    console.log(` • Caption replacement active (${OLD_TEXT_REGEX.length} pattern(s))`); 
} 
console.log(`\n🤖 Bot Commands: !ping, !jid, !gjid`); 
}); 
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
// 1. Connect DB if configured
if (config.mongoDbUrl) {
const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
if (dbResult) {
console.log('✅ Database connected');
}
}

// 2. Start default session 
const sessionId = config.sessionId || 'wasi_session'; 
await startSession(sessionId); 

// 3. Start server 
wasi_startServer(); 
}

main();
