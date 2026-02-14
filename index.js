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
const mongoose = require('mongoose');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

// -----------------------------------------------------------------------------
// MONGODB CONFIG SCHEMA - SESSION ID KE SAATH SAVE HOGA
// -----------------------------------------------------------------------------
const ConfigSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    sourceJids: [String],
    targetJids: [String],
    oldTextRegex: [String],
    newText: String,
    updatedAt: { type: Date, default: Date.now }
});

const BotConfig = mongoose.model('BotConfig', ConfigSchema);

// -----------------------------------------------------------------------------
// SESSION STATE WITH PER-SESSION CONFIGURATION
// -----------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> { sock, isConnected, qr, config, ... }

// -----------------------------------------------------------------------------
// CONFIGURATION LOADER PER SESSION
// -----------------------------------------------------------------------------
async function loadConfigForSession(sessionId) {
    try {
        if (mongoose.connection.readyState === 1) {
            const dbConfig = await BotConfig.findOne({ sessionId: sessionId });
            if (dbConfig) {
                const config = {
                    sourceJids: dbConfig.sourceJirds || [],
                    targetJids: dbConfig.targetJids || [],
                    newText: dbConfig.newText || '',
                    oldTextRegex: dbConfig.oldTextRegex.map(pattern => {
                        try {
                            return pattern ? new RegExp(pattern, 'gu') : null;
                        } catch (e) {
                            console.error(`Invalid regex pattern for session ${sessionId}: ${pattern}`, e);
                            return null;
                        }
                    }).filter(regex => regex !== null)
                };
                console.log(`✅ Config loaded from MongoDB for session: ${sessionId}`);
                return config;
            }
        }
    } catch (e) {
        console.error(`Failed to load config for session ${sessionId} from MongoDB:`, e);
    }
    
    // Default config if nothing found
    return {
        sourceJids: [],
        targetJids: [],
        oldTextRegex: [],
        newText: ''
    };
}

// -----------------------------------------------------------------------------
// SAVE CONFIGURATION PER SESSION
// -----------------------------------------------------------------------------
async function saveConfigForSession(sessionId, configData) {
    try {
        if (mongoose.connection.readyState === 1) {
            await BotConfig.findOneAndUpdate(
                { sessionId: sessionId },
                {
                    sourceJids: configData.sourceJids || [],
                    targetJids: configData.targetJids || [],
                    oldTextRegex: (configData.oldTextRegex || []).map(r => r.source),
                    newText: configData.newText || '',
                    updatedAt: new Date()
                },
                { upsert: true }
            );
            console.log(`✅ Config saved to MongoDB for session: ${sessionId}`);
            return true;
        }
    } catch (error) {
        console.error(`Failed to save config for session ${sessionId}:`, error);
        return false;
    }
}

// -----------------------------------------------------------------------------
// SESSION-SPECIFIC MESSAGE PROCESSING
// -----------------------------------------------------------------------------
function cleanForwardedLabel(message) {
    // ... (same as before)
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
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

function cleanNewsletterText(text) {
    // ... (same as before)
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
    
    return cleanedText.trim();
}

function replaceCaption(caption, sessionConfig) {
    if (!caption) return caption;
    if (!sessionConfig.oldTextRegex.length || !sessionConfig.newText) return caption;
    
    let result = caption;
    sessionConfig.oldTextRegex.forEach(regex => {
        result = result.replace(regex, sessionConfig.newText);
    });
    return result;
}

function processAndCleanMessage(originalMessage, sessionConfig) {
    // ... (modified to use sessionConfig)
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
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText, sessionConfig);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText, sessionConfig);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText, sessionConfig);
            }
        }
        
        delete cleanedMessage.protocolMessage;
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS (with session awareness)
// -----------------------------------------------------------------------------
async function handlePingCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `Love You😘 (Session: ${sessionId})` });
}

async function handleJidCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `${from}` });
}

async function handleGjidCommand(sock, from, sessionId) {
    // ... (same as before)
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   ──────────────\n\n`;
            
            groupCount++;
        }
        
        if (groupCount === 1) {
            response = "❌ No groups found.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }
        
        await sock.sendMessage(from, { text: response });
        
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { 
            text: "❌ Error fetching groups list." 
        });
    }
}

async function processCommand(sock, msg, sessionId) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const command = text.trim().toLowerCase();
    
    try {
        if (command === '!ping') await handlePingCommand(sock, from, sessionId);
        else if (command === '!jid') await handleJidCommand(sock, from, sessionId);
        else if (command === '!gjid') await handleGjidCommand(sock, from, sessionId);
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT WITH PER-SESSION CONFIG
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            return existing;
        }

        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    // Load config for this specific session
    const sessionConfig = await loadConfigForSession(sessionId);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0,
        config: sessionConfig
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

            if (shouldReconnect) {
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

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // Use session-specific config
        const currentSession = sessions.get(sessionId);
        if (!currentSession) return;

        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg, sessionId);
        }

        // Use session-specific config for forwarding
        if (currentSession.config.sourceJids.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message, currentSession.config);
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

                for (const targetJid of currentSession.config.targetJids) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Session ${sessionId}: Forwarded to ${targetJid}`);
                    } catch (err) {
                        console.error(`Session ${sessionId}: Failed to forward to ${targetJid}:`, err.message);
                    }
                }
            } catch (err) {
                console.error(`Session ${sessionId}: Auto Forward Error:`, err.message);
            }
        }
    });

    return sessionState;
}

// -----------------------------------------------------------------------------
// EXPRESS SETUP
// -----------------------------------------------------------------------------
const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// API ROUTES - NOW SESSION-AWARE
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let sessionConfig = null;

    if (session) {
        connected = session.isConnected;
        sessionConfig = session.config;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    const dbConnected = mongoose.connection.readyState === 1;

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        config: sessionConfig,
        activeSessions: Array.from(sessions.keys()),
        databaseConnected: dbConnected
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// PER-SESSION CONFIGURATION API
// -----------------------------------------------------------------------------

// GET config for specific session
wasi_app.get('/api/config', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        sessionId,
        sourceJids: session.config.sourceJids,
        targetJids: session.config.targetJids,
        oldTextRegex: session.config.oldTextRegex.map(regex => regex.source),
        newText: session.config.newText
    });
});

// POST updated config for specific session
wasi_app.post('/api/config', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const { sourceJids, targetJids, oldTextRegex, newText } = req.body;

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        // Update session config
        const updatedConfig = { ...session.config };
        
        if (sourceJids) updatedConfig.sourceJids = sourceJids.filter(s => s && s.trim());
        if (targetJids) updatedConfig.targetJids = targetJids.filter(s => s && s.trim());
        if (oldTextRegex) {
            updatedConfig.oldTextRegex = oldTextRegex
                .map(pattern => {
                    try {
                        return pattern && pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
                    } catch (e) {
                        console.error(`Invalid regex pattern: ${pattern}`, e);
                        return null;
                    }
                })
                .filter(regex => regex !== null);
        }
        if (newText !== undefined) updatedConfig.newText = newText;

        // Save to MongoDB with sessionId
        await saveConfigForSession(sessionId, updatedConfig);

        // Update session state
        session.config = updatedConfig;

        res.json({ 
            success: true, 
            message: `Configuration saved for session: ${sessionId}`,
            sessionId 
        });
    } catch (error) {
        console.error('Config save error:', error);
        res.json({ success: false, error: error.message });
    }
});

// -----------------------------------------------------------------------------
// MULTI-SESSION MANAGEMENT API
// -----------------------------------------------------------------------------

// Start a new session
wasi_app.post('/api/session/start', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
        await startSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} started` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stop a session
wasi_app.post('/api/session/stop', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    const session = sessions.get(sessionId);
    if (session && session.sock) {
        session.sock.end(undefined);
        sessions.delete(sessionId);
        await wasi_clearSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} stopped` });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// List all active sessions
wasi_app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
        sessionId: id,
        connected: data.isConnected,
        hasConfig: !!data.config
    }));
    res.json({ sessions: sessionList });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Multi-session WhatsApp Bot`);
        console.log(`💾 Config saved per session in MongoDB`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // Connect to MongoDB first
    if (config.mongoDbUrl) {
        try {
            await mongoose.connect(config.mongoDbUrl);
            console.log('✅ MongoDB Connected');
        } catch (error) {
            console.error('MongoDB connection error:', error);
        }
    }

    // Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // Start server
    wasi_startServer();
}

main();
