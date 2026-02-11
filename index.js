require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser
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
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? new RegExp(process.env.OLD_TEXT_REGEX, 'gu')
    : '';

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

const replaceCaption = (caption) => {
    if (!caption) return caption;
    
    // اگر OLD_TEXT_REGEX یا NEW_TEXT خالی ہوں تو کچھ نہیں کریں گے
    if (!OLD_TEXT_REGEX || !NEW_TEXT) return caption;
    
    return caption.replace(OLD_TEXT_REGEX, NEW_TEXT);
};

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Handle !ping command
 */
async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
    console.log(`Ping command executed for ${from}`);
}

/**
 * Handle !jid command - Get current chat JID
 */
async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

/**
 * Handle !gjid command - Get all groups with details
 */
async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            // Determine group type
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
 * Process incoming messages for commands
 */
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
// MESSAGE PROCESSING FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Extract original message without forward/newsletter tags
 */
function extractOriginalMessage(msg) {
    let messageToSend = {};
    const message = msg.message;
    
    // Remove any contextInfo (which contains forwarding info)
    const cleanMessage = { ...message };
    
    // Check and remove contextInfo from extendedTextMessage
    if (cleanMessage.extendedTextMessage?.contextInfo) {
        delete cleanMessage.extendedTextMessage.contextInfo;
    }
    
    // Check and remove contextInfo from imageMessage
    if (cleanMessage.imageMessage?.contextInfo) {
        delete cleanMessage.imageMessage.contextInfo;
    }
    
    // Check and remove contextInfo from videoMessage
    if (cleanMessage.videoMessage?.contextInfo) {
        delete cleanMessage.videoMessage.contextInfo;
    }
    
    // Check and remove contextInfo from documentMessage
    if (cleanMessage.documentMessage?.contextInfo) {
        delete cleanMessage.documentMessage.contextInfo;
    }
    
    // Check and remove contextInfo from audioMessage
    if (cleanMessage.audioMessage?.contextInfo) {
        delete cleanMessage.audioMessage.contextInfo;
    }
    
    // Check and remove contextInfo from stickerMessage
    if (cleanMessage.stickerMessage?.contextInfo) {
        delete cleanMessage.stickerMessage.contextInfo;
    }
    
    // Handle different message types
    if (cleanMessage.conversation) {
        messageToSend = { text: cleanMessage.conversation };
    }
    else if (cleanMessage.extendedTextMessage?.text) {
        messageToSend = { 
            text: cleanMessage.extendedTextMessage.text,
            mentions: cleanMessage.extendedTextMessage.mentionedJid || []
        };
    }
    else if (cleanMessage.imageMessage) {
        messageToSend = {
            image: cleanMessage.imageMessage,
            caption: replaceCaption(cleanMessage.imageMessage.caption)
        };
    }
    else if (cleanMessage.videoMessage) {
        messageToSend = {
            video: cleanMessage.videoMessage,
            caption: replaceCaption(cleanMessage.videoMessage.caption)
        };
    }
    else if (cleanMessage.audioMessage) {
        messageToSend = {
            audio: cleanMessage.audioMessage
        };
    }
    else if (cleanMessage.documentMessage) {
        messageToSend = {
            document: cleanMessage.documentMessage,
            caption: replaceCaption(cleanMessage.documentMessage.caption),
            mimetype: cleanMessage.documentMessage.mimetype,
            fileName: cleanMessage.documentMessage.fileName
        };
    }
    else if (cleanMessage.stickerMessage) {
        messageToSend = {
            sticker: cleanMessage.stickerMessage
        };
    }
    // Handle view once messages
    else if (cleanMessage.viewOnceMessageV2?.message) {
        const viewOnceMsg = cleanMessage.viewOnceMessageV2.message;
        return extractOriginalMessage({ message: viewOnceMsg });
    }
    else if (cleanMessage.viewOnceMessage?.message) {
        const viewOnceMsg = cleanMessage.viewOnceMessage.message;
        return extractOriginalMessage({ message: viewOnceMsg });
    }
    
    return messageToSend;
}

/**
 * Send message as new (not forwarded)
 */
async function sendAsNewMessage(sock, targetJid, messageObj) {
    try {
        // Check if messageObj is valid
        if (!messageObj || Object.keys(messageObj).length === 0) {
            console.log('Empty message object, skipping');
            return;
        }
        
        // Send based on message type
        if (messageObj.text) {
            await sock.sendMessage(targetJid, { 
                text: messageObj.text,
                mentions: messageObj.mentions || []
            });
        }
        else if (messageObj.image) {
            await sock.sendMessage(targetJid, {
                image: messageObj.image,
                caption: messageObj.caption || '',
                mimetype: messageObj.image.mimetype || 'image/jpeg'
            });
        }
        else if (messageObj.video) {
            await sock.sendMessage(targetJid, {
                video: messageObj.video,
                caption: messageObj.caption || '',
                mimetype: messageObj.video.mimetype || 'video/mp4'
            });
        }
        else if (messageObj.audio) {
            await sock.sendMessage(targetJid, {
                audio: messageObj.audio,
                mimetype: messageObj.audio.mimetype || 'audio/mpeg',
                ptt: messageObj.audio.ptt || false
            });
        }
        else if (messageObj.document) {
            await sock.sendMessage(targetJid, {
                document: messageObj.document,
                caption: messageObj.caption || '',
                mimetype: messageObj.mimetype || 'application/octet-stream',
                fileName: messageObj.fileName || 'document'
            });
        }
        else if (messageObj.sticker) {
            await sock.sendMessage(targetJid, {
                sticker: messageObj.sticker
            });
        }
        
        console.log(`✅ Sent as new message to ${targetJid}`);
    } catch (err) {
        console.error(`Failed to send new message to ${targetJid}:`, err.message);
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

    // -------------------------------------------------------------------------
    // AUTO FORWARD MESSAGE HANDLER
    // -------------------------------------------------------------------------
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
                // Check for Media or Emoji Only (as per your existing logic)
                let relayMsg = { ...wasi_msg.message };
                
                // View Once Unwrap
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

                // Only forward if media or emoji (your existing condition)
                if (!isMedia && !isEmojiOnly) return;

                console.log(`📦 Processing message from ${wasi_origin}`);

                // Extract original message (removes forward tags, newsletter info, etc.)
                const originalMessage = extractOriginalMessage(wasi_msg);
                
                // Send as new message to all target JIDs
                for (const targetJid of TARGET_JIDS) {
                    try {
                        await sendAsNewMessage(wasi_sock, targetJid, originalMessage);
                        console.log(`✅ Message sent to ${targetJid} (without forward tags)`);
                    } catch (err) {
                        console.error(`Failed to send to ${targetJid}:`, err.message);
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
            } catch (e) { }
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        activeSessions: Array.from(sessions.keys())
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
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
        console.log(`🔄 Forward tags will be removed from all forwarded messages`);
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

// Start the application
main().catch(console.error);
