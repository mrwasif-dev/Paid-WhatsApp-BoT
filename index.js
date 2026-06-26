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
// HELPER FUNCTIONS FOR CAPTION CLEANING
// -----------------------------------------------------------------------------

/**
 * Remove bold (*) and italic (_) markers from text
 * Keep emojis and other special characters
 */
function removeBoldItalicMarkers(text) {
    if (!text) return text;
    
    // Remove * (bold) markers
    let cleaned = text.replace(/\*/g, '');
    // Remove _ (italic) markers
    cleaned = cleaned.replace(/_/g, '');
    
    return cleaned;
}

/**
 * Clean caption by removing bold/italic markers and adding custom footer
 */
function cleanCaption(caption) {
    if (!caption) return caption;
    
    // Step 1: Remove bold and italic markers
    let cleanedCaption = removeBoldItalicMarkers(caption);
    
    // Step 2: Add custom footer
    const footer = '\n\nᴀᴜᴛᴏ ғᴏʀᴡᴏʀᴅ ᴘᴏsᴛ ʙʏ ʙᴏᴛ';
    cleanedCaption = cleanedCaption + footer;
    
    return cleanedCaption;
}

/**
 * Process caption for all message types
 */
function processCaption(message) {
    try {
        let caption = null;
        let messageType = null;
        
        // Check different message types for caption/text
        if (message.conversation) {
            caption = message.conversation;
            messageType = 'conversation';
        } else if (message.extendedTextMessage?.text) {
            caption = message.extendedTextMessage.text;
            messageType = 'extendedText';
        } else if (message.imageMessage?.caption) {
            caption = message.imageMessage.caption;
            messageType = 'image';
        } else if (message.videoMessage?.caption) {
            caption = message.videoMessage.caption;
            messageType = 'video';
        } else if (message.documentMessage?.caption) {
            caption = message.documentMessage.caption;
            messageType = 'document';
        }
        
        if (!caption) return message;
        
        // Clean the caption
        const cleanedCaption = cleanCaption(caption);
        
        // Update the message with cleaned caption
        const cleanedMessage = JSON.parse(JSON.stringify(message));
        
        if (messageType === 'conversation') {
            cleanedMessage.conversation = cleanedCaption;
        } else if (messageType === 'extendedText') {
            cleanedMessage.extendedTextMessage.text = cleanedCaption;
        } else if (messageType === 'image') {
            cleanedMessage.imageMessage.caption = cleanedCaption;
        } else if (messageType === 'video') {
            cleanedMessage.videoMessage.caption = cleanedCaption;
        } else if (messageType === 'document') {
            cleanedMessage.documentMessage.caption = cleanedCaption;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing caption:', error);
        return message;
    }
}

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
    // AUTO FORWARD MESSAGE HANDLER - ONLY VIDEOS WITH CAPTION CLEANING
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

        // AUTO FORWARD LOGIC - ONLY VIDEOS
        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                // Process and clean caption
                let relayMsg = processCaption(wasi_msg.message);
                
                if (!relayMsg) return;

                // View Once Unwrap
                if (relayMsg.viewOnceMessageV2)
                    relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage)
                    relayMsg = relayMsg.viewOnceMessage.message;

                // ✅ CHECK FOR VIDEO ONLY - IGNORE EVERYTHING ELSE
                const isVideo = relayMsg.videoMessage ? true : false;
                
                // ONLY FORWARD IF IT'S A VIDEO
                if (!isVideo) return;

                console.log(`📦 Forwarding video from ${wasi_origin}`);

                // Forward to all target JIDs
                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Video forwarded to ${targetJid}`);
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
        console.log(`🎥 ONLY VIDEOS WILL BE FORWARDED`);
        console.log(`✨ Caption Cleaning: Bold/Italic markers removed`);
        console.log(`📝 Custom Footer: ᴀᴜᴛᴏ ғᴏʀᴡᴏʀᴅ ᴘᴏsᴛ ʙʏ ʙᴏᴛ`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
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
