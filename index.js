require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    useMultiFileAuthState,
    makeWASocket,
    Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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

// -----------------------------------------------------------------------------
// TELEGRAM BOT CONFIG
// -----------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;

if (TELEGRAM_TOKEN) {
    telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    console.log('✅ Telegram Bot initialized!');
}

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();
const qrTimeouts = new Map();
const keepAliveIntervals = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION
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

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

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

function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    
    return result;
}

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
        } 
        else if (command === '!jid') {
            await handleJidCommand(sock, from);
        }
        else if (command === '!gjid') {
            await handleGjidCommand(sock, from);
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// DOWNLOAD TELEGRAM MEDIA
// -----------------------------------------------------------------------------
async function downloadTelegramMedia(fileId) {
    try {
        const fileLink = await telegramBot.getFileLink(fileId);
        const response = await axios({
            method: 'get',
            url: fileLink,
            responseType: 'arraybuffer'
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Error downloading Telegram media:', error.message);
        throw error;
    }
}

// -----------------------------------------------------------------------------
// FORWARD TELEGRAM MEDIA TO WHATSAPP
// -----------------------------------------------------------------------------
async function forwardTelegramMediaToWhatsApp(sock, mediaBuffer, mimeType, caption, fileName) {
    if (!sock) {
        console.log('❌ WhatsApp socket not available!');
        return false;
    }

    const results = [];

    for (const targetJid of TARGET_JIDS) {
        try {
            const message = {
                caption: caption || '',
                mimetype: mimeType,
                fileName: fileName || 'media_file',
            };

            if (mimeType.startsWith('image/')) {
                message.image = mediaBuffer;
            } else if (mimeType.startsWith('video/')) {
                message.video = mediaBuffer;
            } else if (mimeType.startsWith('audio/')) {
                message.audio = mediaBuffer;
                message.ptt = false;
                message.mimetype = mimeType;
            } else {
                message.document = mediaBuffer;
                message.mimetype = mimeType;
            }

            await sock.sendMessage(targetJid, message);
            console.log(`✅ Telegram media sent to ${targetJid}`);
            results.push({ target: targetJid, success: true });
        } catch (error) {
            console.error(`❌ Failed to send to ${targetJid}:`, error.message);
            results.push({ target: targetJid, success: false, error: error.message });
        }
    }

    return results;
}

// -----------------------------------------------------------------------------
// KEEP-ALIVE MECHANISM
// -----------------------------------------------------------------------------
function startKeepAlive(sessionId, sock) {
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }
    
    console.log(`🔄 Starting keep-alive for session: ${sessionId}`);
    
    const interval = setInterval(async () => {
        try {
            const session = sessions.get(sessionId);
            if (!session || !session.isConnected || !session.sock) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
                return;
            }
            await session.sock.sendPresenceAvailable();
        } catch (error) {
            if (error.message?.includes('reconnecting')) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
            }
        }
    }, 30000);
    
    keepAliveIntervals.set(sessionId, interval);
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (qrTimeouts.has(sessionId)) {
        clearTimeout(qrTimeouts.get(sessionId));
        qrTimeouts.delete(sessionId);
    }
    
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            startKeepAlive(sessionId, existing.sock);
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
        lastQRTime: null,
        isConnecting: false,
        lastConnectionTime: null,
    };
    sessions.set(sessionId, sessionState);

    try {
        const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
        sessionState.sock = wasi_sock;
        sessionState.isConnecting = true;

        wasi_sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionState.qr = qr;
                sessionState.isConnected = false;
                sessionState.lastQRTime = Date.now();
                console.log(`📱 QR generated for session: ${sessionId}`);
                
                // Send QR to Telegram if available
                if (telegramBot && TELEGRAM_CHAT_ID) {
                    try {
                        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `📱 Scan this QR code to connect WhatsApp:\n\`${qr}\``);
                    } catch (e) {
                        console.error('Failed to send QR to Telegram:', e.message);
                    }
                }
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                }
                
                const timeout = setTimeout(() => {
                    console.log(`⏰ QR code expired for session: ${sessionId}, regenerating...`);
                    if (!sessionState.isConnected && sessionState.sock) {
                        sessionState.sock.end(undefined);
                        setTimeout(() => {
                            startSession(sessionId);
                        }, 1000);
                    }
                }, 120000);
                
                qrTimeouts.set(sessionId, timeout);
            }

            if (connection === 'close') {
                sessionState.isConnected = false;
                sessionState.isConnecting = false;
                sessionState.lastConnectionTime = Date.now();
                
                if (keepAliveIntervals.has(sessionId)) {
                    clearInterval(keepAliveIntervals.get(sessionId));
                    keepAliveIntervals.delete(sessionId);
                }
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                const statusCode = (lastDisconnect?.error instanceof Boom) ?
                    lastDisconnect.error.output.statusCode : 500;

                const isLoggedOut = statusCode === DisconnectReason.loggedOut || 
                                   statusCode === 440 ||
                                   lastDisconnect?.error?.message?.includes('401');

                if (isLoggedOut) {
                    console.log(`❌ Session ${sessionId} logged out. Removing session.`);
                    sessions.delete(sessionId);
                    await wasi_clearSession(sessionId);
                    if (telegramBot && TELEGRAM_CHAT_ID) {
                        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `❌ WhatsApp session logged out!`);
                    }
                    return;
                }

                const delay = Math.min(3000 * Math.pow(1.5, sessionState.reconnectAttempts), 30000);
                sessionState.reconnectAttempts += 1;

                console.log(`Session ${sessionId}: Connection closed, reconnecting in ${delay}ms (attempt ${sessionState.reconnectAttempts})`);

                setTimeout(() => {
                    if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                        startSession(sessionId);
                    }
                }, delay);
                
            } else if (connection === 'open') {
                sessionState.isConnected = true;
                sessionState.isConnecting = false;
                sessionState.qr = null;
                sessionState.reconnectAttempts = 0;
                sessionState.lastConnectionTime = Date.now();
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                console.log(`✅ ${sessionId}: Connected to WhatsApp`);
                
                if (telegramBot && TELEGRAM_CHAT_ID) {
                    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `✅ WhatsApp connected successfully!`);
                }
                
                startKeepAlive(sessionId, wasi_sock);
                
                try {
                    await wasi_sock.sendPresenceAvailable();
                } catch (e) {}
            }
        });

        wasi_sock.ev.on('creds.update', saveCreds);

        // AUTO FORWARD MESSAGE HANDLER (WhatsApp → WhatsApp)
        wasi_sock.ev.on('messages.upsert', async wasi_m => {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg.message) return;

            const wasi_origin = wasi_msg.key.remoteJid;
            const wasi_text = wasi_msg.message.conversation ||
                wasi_msg.message.extendedTextMessage?.text ||
                wasi_msg.message.imageMessage?.caption ||
                wasi_msg.message.videoMessage?.caption ||
                wasi_msg.message.documentMessage?.caption || "";

            if (wasi_text.startsWith('!')) {
                await processCommand(wasi_sock, wasi_msg);
            }

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
        });

        wasi_sock.ev.on('error', (error) => {
            console.error(`Socket error for session ${sessionId}:`, error);
        });

    } catch (error) {
        console.error(`Failed to start session ${sessionId}:`, error);
        setTimeout(() => {
            if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                startSession(sessionId);
            }
        }, 5000);
    }
}

// -----------------------------------------------------------------------------
// TELEGRAM MESSAGE HANDLER
// -----------------------------------------------------------------------------
if (telegramBot) {
    telegramBot.on('message', async (msg) => {
        try {
            const chatId = msg.chat.id;
            const from = msg.from?.username || msg.from?.first_name || 'Unknown';
            
            // Only process if from authorized chat
            if (TELEGRAM_CHAT_ID && chatId.toString() !== TELEGRAM_CHAT_ID.toString()) {
                return;
            }

            const session = sessions.get(config.sessionId || 'wasi_session');
            if (!session || !session.isConnected || !session.sock) {
                await telegramBot.sendMessage(chatId, '❌ WhatsApp is not connected!');
                return;
            }

            // ==========================================
            // 📷 IMAGE HANDLER
            // ==========================================
            if (msg.photo) {
                console.log(`📷 Image received from Telegram: ${from}`);
                
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const caption = msg.caption || '';
                
                const buffer = await downloadTelegramMedia(fileId);
                await forwardTelegramMediaToWhatsApp(
                    session.sock,
                    buffer,
                    'image/jpeg',
                    caption,
                    'image.jpg'
                );
                
                await telegramBot.sendMessage(chatId, '✅ Image forwarded to WhatsApp!');
            }

            // ==========================================
            // 🎬 VIDEO HANDLER
            // ==========================================
            else if (msg.video) {
                console.log(`🎬 Video received from Telegram: ${from}`);
                
                const fileId = msg.video.file_id;
                const caption = msg.caption || '';
                const fileName = msg.video.file_name || 'video.mp4';
                
                if (msg.video.file_size > 2 * 1024 * 1024 * 1024) {
                    await telegramBot.sendMessage(chatId, '❌ Video size exceeds 2GB!');
                    return;
                }
                
                const buffer = await downloadTelegramMedia(fileId);
                await forwardTelegramMediaToWhatsApp(
                    session.sock,
                    buffer,
                    msg.video.mime_type || 'video/mp4',
                    caption,
                    fileName
                );
                
                await telegramBot.sendMessage(chatId, '✅ Video forwarded to WhatsApp!');
            }

            // ==========================================
            // 📄 DOCUMENT HANDLER
            // ==========================================
            else if (msg.document) {
                console.log(`📄 Document received from Telegram: ${from}`);
                
                const fileId = msg.document.file_id;
                const caption = msg.caption || '';
                const fileName = msg.document.file_name || 'document.pdf';
                const mimeType = msg.document.mime_type || 'application/octet-stream';
                
                if (msg.document.file_size > 2 * 1024 * 1024 * 1024) {
                    await telegramBot.sendMessage(chatId, '❌ File size exceeds 2GB!');
                    return;
                }
                
                const buffer = await downloadTelegramMedia(fileId);
                await forwardTelegramMediaToWhatsApp(
                    session.sock,
                    buffer,
                    mimeType,
                    caption,
                    fileName
                );
                
                await telegramBot.sendMessage(chatId, '✅ Document forwarded to WhatsApp!');
            }

            // ==========================================
            // 🎵 AUDIO HANDLER
            // ==========================================
            else if (msg.audio || msg.voice) {
                console.log(`🎵 Audio received from Telegram: ${from}`);
                
                const fileId = msg.audio?.file_id || msg.voice?.file_id;
                const caption = msg.caption || '';
                const mimeType = msg.audio?.mime_type || msg.voice?.mime_type || 'audio/mpeg';
                const fileName = msg.audio?.file_name || msg.voice?.file_name || 'audio.mp3';
                
                const buffer = await downloadTelegramMedia(fileId);
                await forwardTelegramMediaToWhatsApp(
                    session.sock,
                    buffer,
                    mimeType,
                    caption,
                    fileName
                );
                
                await telegramBot.sendMessage(chatId, '✅ Audio forwarded to WhatsApp!');
            }

            // ==========================================
            // 📝 TEXT MESSAGE HANDLER
            // ==========================================
            else if (msg.text) {
                console.log(`📝 Text received from Telegram: ${from}`);
                
                for (const targetJid of TARGET_JIDS) {
                    try {
                        await session.sock.sendMessage(targetJid, {
                            text: `📨 From Telegram (@${from}):\n\n${msg.text}`
                        });
                        console.log(`✅ Text sent to ${targetJid}`);
                    } catch (error) {
                        console.error(`❌ Failed to send text to ${targetJid}:`, error.message);
                    }
                }

                await telegramBot.sendMessage(chatId, '✅ Text forwarded to WhatsApp!');
            }

        } catch (error) {
            console.error('❌ Telegram handler error:', error);
            if (msg?.chat?.id) {
                await telegramBot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
            }
        }
    });

    console.log('🤖 Telegram bot listening for messages...');
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

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

    const isConnecting = session?.isConnecting || false;
    const hasKeepAlive = keepAliveIntervals.has(sessionId);

    res.json({
        sessionId,
        connected,
        isConnecting,
        qr: qrDataUrl,
        qrAvailable: !!session?.qr,
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        telegramEnabled: !!TELEGRAM_TOKEN,
        phoneNumber: connected ? 'Connected ✅' : (isConnecting ? 'Connecting...' : 'Disconnected'),
        lastActive: new Date().toISOString(),
        keepAliveActive: hasKeepAlive,
        uptime: session?.lastConnectionTime ? Math.floor((Date.now() - session.lastConnectionTime) / 1000) + 's' : 'N/A',
        activeSessions: Array.from(sessions.keys()).map(id => ({
            id,
            connected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            keepAlive: keepAliveIntervals.has(id)
        }))
    });
});

wasi_app.post('/api/generate-qr', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        if (session && session.sock) {
            session.sock.end(undefined);
            setTimeout(() => {
                startSession(sessionId);
            }, 1000);
            res.json({ success: true, message: 'Generating new QR code...' });
        } else {
            startSession(sessionId);
            res.json({ success: true, message: 'Starting session with new QR...' });
        }
    } catch (error) {
        console.error('Generate QR error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        
        for (const [sessionId, interval] of keepAliveIntervals) {
            clearInterval(interval);
        }
        keepAliveIntervals.clear();
        
        for (const [sessionId, timeout] of qrTimeouts) {
            clearTimeout(timeout);
        }
        qrTimeouts.clear();
        
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

wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        if (qrTimeouts.has(sessionId)) {
            clearTimeout(qrTimeouts.get(sessionId));
            qrTimeouts.delete(sessionId);
        }
        
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

wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            isConnecting: sessions.get(id)?.isConnecting || false,
            keepAliveActive: keepAliveIntervals.has(id)
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length,
            activeKeepAlives: keepAliveIntervals.size,
            telegramEnabled: !!TELEGRAM_TOKEN
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        qrTimeouts: qrTimeouts.size,
        keepAliveCount: keepAliveIntervals.size,
        telegramEnabled: !!TELEGRAM_TOKEN
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
        console.log(`🤖 Telegram: ${TELEGRAM_TOKEN ? 'Enabled ✅' : 'Disabled ❌'}`);
        console.log(`🔄 Keep-Alive: Active (prevents 50-min timeout)`);
        console.log(`\n📌 API Endpoints:`);
        console.log(`   GET  /api/status      - Get bot status`);
        console.log(`   POST /api/generate-qr - Generate new QR code`);
        console.log(`   POST /api/restart     - Restart bot`);
        console.log(`   POST /api/logout      - Logout bot`);
        console.log(`   GET  /api/sessions    - List all sessions`);
        console.log(`   GET  /api/health      - Health check`);
        console.log(`\n📌 Telegram Features:`);
        console.log(`   Send any media (photo/video/document/audio) → Auto forwards to WhatsApp`);
        console.log(`   Send text → Auto forwards to WhatsApp`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

main();
