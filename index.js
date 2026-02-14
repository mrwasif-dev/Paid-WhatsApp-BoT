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
// DEFAULT CONFIG FROM ENV (GLOBAL DEFAULTS)
// -----------------------------------------------------------------------------
let DEFAULT_SOURCE_JIDS = [];
let DEFAULT_TARGET_JIDS = [];
let DEFAULT_OLD_TEXT_REGEX = [];
let DEFAULT_NEW_TEXT = '';

// Environment se default config load karo
if (process.env.SOURCE_JIDS) {
    DEFAULT_SOURCE_JIDS = process.env.SOURCE_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.TARGET_JIDS) {
    DEFAULT_TARGET_JIDS = process.env.TARGET_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.OLD_TEXT_REGEX) {
    DEFAULT_OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
    }).filter(regex => regex !== null);
}
if (process.env.NEW_TEXT) {
    DEFAULT_NEW_TEXT = process.env.NEW_TEXT;
}

console.log('✅ Default config loaded from .env');

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
// CONFIGURATION LOADER PER SESSION (WITH MULTIPLE SOURCES)
// -----------------------------------------------------------------------------
async function loadConfigForSession(sessionId) {
    let configData = {
        sourceJids: [],
        targetJids: [],
        oldTextRegex: [],
        newText: '',
        _source: 'none'
    };

    // PRIORITY 1: MongoDB se load karo
    try {
        if (mongoose.connection.readyState === 1) {
            const dbConfig = await BotConfig.findOne({ sessionId: sessionId });
            if (dbConfig) {
                console.log(`📦 MongoDB raw data for ${sessionId}:`, JSON.stringify({
                    sourceJids: dbConfig.sourceJids,
                    targetJids: dbConfig.targetJids,
                    oldTextRegex: dbConfig.oldTextRegex,
                    newText: dbConfig.newText
                }, null, 2));
                
                configData = {
                    sourceJids: dbConfig.sourceJids || [],
                    targetJids: dbConfig.targetJids || [],
                    newText: dbConfig.newText || '',
                    oldTextRegex: (dbConfig.oldTextRegex || []).map(pattern => {
                        try {
                            return pattern ? new RegExp(pattern, 'gu') : null;
                        } catch (e) {
                            console.error(`Invalid regex pattern for session ${sessionId}: ${pattern}`, e);
                            return null;
                        }
                    }).filter(regex => regex !== null),
                    _source: 'mongodb'
                };
                console.log(`✅ Config loaded from MongoDB for session: ${sessionId}`);
                console.log(`📋 Loaded sourceJids:`, configData.sourceJids);
                console.log(`📋 Loaded targetJids:`, configData.targetJids);
                return configData;
            }
        }
    } catch (e) {
        console.error(`Failed to load config for session ${sessionId} from MongoDB:`, e);
    }
    
    // PRIORITY 2: JSON file se load karo
    try {
        const jsonPath = path.join(__dirname, `${sessionId}_config.json`);
        if (fs.existsSync(jsonPath)) {
            const savedConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            
            configData = {
                sourceJids: savedConfig.sourceJids || [],
                targetJids: savedConfig.targetJids || [],
                newText: savedConfig.newText || '',
                oldTextRegex: (savedConfig.oldTextRegex || []).map(pattern => {
                    try {
                        return pattern ? new RegExp(pattern, 'gu') : null;
                    } catch (e) {
                        console.error(`Invalid regex pattern: ${pattern}`, e);
                        return null;
                    }
                }).filter(regex => regex !== null),
                _source: 'json'
            };
            console.log(`✅ Config loaded from ${sessionId}_config.json`);
            console.log(`📋 Loaded sourceJids:`, configData.sourceJids);
            console.log(`📋 Loaded targetJids:`, configData.targetJids);
            return configData;
        }
    } catch (e) {
        console.error(`Failed to load ${sessionId}_config.json:`, e);
    }
    
    // PRIORITY 3: Default config (ENV) use karo
    if (DEFAULT_SOURCE_JIDS.length > 0 || DEFAULT_TARGET_JIDS.length > 0 || DEFAULT_NEW_TEXT) {
        configData = {
            sourceJids: [...DEFAULT_SOURCE_JIDS],
            targetJids: [...DEFAULT_TARGET_JIDS],
            oldTextRegex: [...DEFAULT_OLD_TEXT_REGEX],
            newText: DEFAULT_NEW_TEXT,
            _source: 'env'
        };
        console.log(`✅ Using default config from .env for session: ${sessionId}`);
        console.log(`📋 Loaded sourceJids:`, configData.sourceJids);
        console.log(`📋 Loaded targetJids:`, configData.targetJids);
    } else {
        console.log(`⚠️ No config found for session: ${sessionId}, using empty config`);
        configData._source = 'empty';
    }
    
    return configData;
}

// -----------------------------------------------------------------------------
// SAVE CONFIGURATION PER SESSION (TO BOTH MongoDB AND JSON)
// -----------------------------------------------------------------------------
async function saveConfigForSession(sessionId, configData) {
    let savedToMongo = false;
    let savedToJson = false;
    
    console.log(`💾 Saving config for session: ${sessionId}`);
    console.log(`📋 Source JIDs to save:`, configData.sourceJids);
    console.log(`📋 Target JIDs to save:`, configData.targetJids);
    
    // Save to MongoDB
    try {
        if (mongoose.connection.readyState === 1) {
            const updateData = {
                sourceJids: configData.sourceJids || [],
                targetJids: configData.targetJids || [],
                oldTextRegex: (configData.oldTextRegex || []).map(r => r.source),
                newText: configData.newText || '',
                updatedAt: new Date()
            };
            
            await BotConfig.findOneAndUpdate(
                { sessionId: sessionId },
                updateData,
                { upsert: true, new: true }
            );
            console.log(`✅ Config saved to MongoDB for session: ${sessionId}`);
            savedToMongo = true;
        }
    } catch (error) {
        console.error(`Failed to save config for session ${sessionId} to MongoDB:`, error);
    }
    
    // Save to JSON file
    try {
        const jsonPath = path.join(__dirname, `${sessionId}_config.json`);
        const jsonConfig = {
            sourceJids: configData.sourceJids || [],
            targetJids: configData.targetJids || [],
            oldTextRegex: (configData.oldTextRegex || []).map(r => r.source),
            newText: configData.newText || '',
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(jsonPath, JSON.stringify(jsonConfig, null, 2));
        console.log(`✅ Config saved to ${sessionId}_config.json`);
        savedToJson = true;
    } catch (error) {
        console.error(`Failed to save ${sessionId}_config.json:`, error);
    }
    
    return { savedToMongo, savedToJson };
}

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
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------
async function handlePingCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `Love You😘 (Session: ${sessionId})` });
}

async function handleJidCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `${from}` });
}

async function handleGjidCommand(sock, from, sessionId) {
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
// SESSION MANAGEMENT
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
            console.log(`📋 Active config for ${sessionId}:`, {
                sourceJids: sessionState.config.sourceJids,
                targetJids: sessionState.config.targetJids
            });
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

        const currentSession = sessions.get(sessionId);
        if (!currentSession) return;

        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg, sessionId);
        }

        // Check if source JID matches
        if (currentSession.config.sourceJids.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            console.log(`🎯 Source matched in ${sessionId}: ${wasi_origin}`);
            
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
// API ROUTES
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
        config: {
            sourceJids: sessionConfig?.sourceJids || [],
            targetJids: sessionConfig?.targetJids || [],
            oldTextRegex: sessionConfig?.oldTextRegex?.map(r => r.source) || [],
            newText: sessionConfig?.newText || '',
            configSource: sessionConfig?._source || 'none'
        },
        activeSessions: Array.from(sessions.keys()),
        databaseConnected: dbConnected
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
        newText: session.config.newText,
        configSource: session.config._source || 'memory'
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
        
        if (sourceJids !== undefined) {
            updatedConfig.sourceJids = sourceJids.filter(s => s && s.trim());
        }
        if (targetJids !== undefined) {
            updatedConfig.targetJids = targetJids.filter(s => s && s.trim());
        }
        if (oldTextRegex !== undefined) {
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
        if (newText !== undefined) {
            updatedConfig.newText = newText;
        }
        
        updatedConfig._source = 'api';

        // Save to both MongoDB and JSON
        const saveResult = await saveConfigForSession(sessionId, updatedConfig);

        // Update session state
        session.config = updatedConfig;

        res.json({ 
            success: true, 
            message: `Configuration saved for session: ${sessionId}`,
            sessionId,
            savedToMongo: saveResult.savedToMongo,
            savedToJson: saveResult.savedToJson,
            config: {
                sourceJids: updatedConfig.sourceJids,
                targetJids: updatedConfig.targetJids
            }
        });
    } catch (error) {
        console.error('Config save error:', error);
        res.json({ success: false, error: error.message });
    }
});

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
        configSource: data.config?._source || 'none',
        sourceCount: data.config?.sourceJids?.length || 0,
        targetCount: data.config?.targetJids?.length || 0,
        sourceJids: data.config?.sourceJids || [],
        targetJids: data.config?.targetJids || []
    }));
    res.json({ sessions: sessionList });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Multi-session WhatsApp Bot`);
        console.log(`💾 Config saved per session in MongoDB and JSON backup`);
        console.log(`📋 Default config from .env: ${DEFAULT_SOURCE_JIDS.length} sources, ${DEFAULT_TARGET_JIDS.length} targets\n`);
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
