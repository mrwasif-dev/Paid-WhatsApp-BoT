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
// DEFAULT CONFIG FROM ENV
// -----------------------------------------------------------------------------
let DEFAULT_SOURCE_JIDS = [];
let DEFAULT_TARGET_JIDS = [];
let DEFAULT_OLD_TEXT_REGEX = [];
let DEFAULT_NEW_TEXT = '';

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
// MONGODB CONFIG SCHEMA
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
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// -----------------------------------------------------------------------------
// CONFIGURATION LOADER
// -----------------------------------------------------------------------------
async function loadConfigForSession(sessionId) {
    let configData = {
        sourceJids: [],
        targetJids: [],
        oldTextRegex: [],
        newText: '',
        _source: 'none'
    };

    // MongoDB
    try {
        if (mongoose.connection.readyState === 1) {
            const dbConfig = await BotConfig.findOne({ sessionId: sessionId });
            if (dbConfig) {
                configData = {
                    sourceJids: dbConfig.sourceJids || [],
                    targetJids: dbConfig.targetJids || [],
                    newText: dbConfig.newText || '',
                    oldTextRegex: (dbConfig.oldTextRegex || []).map(pattern => {
                        try {
                            return pattern ? new RegExp(pattern, 'gu') : null;
                        } catch (e) {
                            return null;
                        }
                    }).filter(regex => regex !== null),
                    _source: 'mongodb'
                };
                console.log(`✅ Config loaded from MongoDB for session: ${sessionId}`);
                return configData;
            }
        }
    } catch (e) {
        console.error(`Failed to load config for session ${sessionId} from MongoDB:`, e);
    }
    
    // JSON file
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
                        return null;
                    }
                }).filter(regex => regex !== null),
                _source: 'json'
            };
            console.log(`✅ Config loaded from ${sessionId}_config.json`);
            return configData;
        }
    } catch (e) {
        console.error(`Failed to load ${sessionId}_config.json:`, e);
    }
    
    // Default config
    if (DEFAULT_SOURCE_JIDS.length > 0 || DEFAULT_TARGET_JIDS.length > 0 || DEFAULT_NEW_TEXT) {
        configData = {
            sourceJids: [...DEFAULT_SOURCE_JIDS],
            targetJids: [...DEFAULT_TARGET_JIDS],
            oldTextRegex: [...DEFAULT_OLD_TEXT_REGEX],
            newText: DEFAULT_NEW_TEXT,
            _source: 'env'
        };
        console.log(`✅ Using default config from .env for session: ${sessionId}`);
    }
    
    return configData;
}

// -----------------------------------------------------------------------------
// SAVE CONFIGURATION
// -----------------------------------------------------------------------------
async function saveConfigForSession(sessionId, configData) {
    let savedToMongo = false;
    let savedToJson = false;
    
    // MongoDB
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
                { upsert: true }
            );
            console.log(`✅ Config saved to MongoDB for session: ${sessionId}`);
            savedToMongo = true;
        }
    } catch (error) {
        console.error(`Failed to save config for session ${sessionId} to MongoDB:`, error);
    }
    
    // JSON file
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
// MESSAGE CLEANING FUNCTIONS
// -----------------------------------------------------------------------------
function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        const messageTypes = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
        
        messageTypes.forEach(type => {
            if (cleanedMessage[type]?.contextInfo) {
                cleanedMessage[type].contextInfo.isForwarded = false;
                if (cleanedMessage[type].contextInfo.forwardingScore) {
                    cleanedMessage[type].contextInfo.forwardingScore = 0;
                }
            }
        });
        
        return cleanedMessage;
    } catch (error) {
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const markers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞️\s*/g,
        /\[NEWSLETTER\]/gi, /\[BROADCAST\]/gi, /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi, /Broadcast:/gi, /Announcement:/gi,
        /Forwarded many times/gi, /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    markers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

function replaceCaption(caption, sessionConfig) {
    if (!caption || !sessionConfig.oldTextRegex.length || !sessionConfig.newText) return caption;
    
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
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLERS
// -----------------------------------------------------------------------------
async function handlePingCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `🤖 *Session:* ${sessionId}\n💓 *Status:* Active` });
}

async function handleJidCommand(sock, from, sessionId) {
    await sock.sendMessage(from, { text: `📱 *Your JID:*\n\`${from}\`` });
}

async function handleGjidCommand(sock, from, sessionId) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            response += `${groupCount}. *${group.subject || "Unnamed"}*\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   ──────────────\n\n`;
            groupCount++;
        }
        
        response += `\n*Total: ${groupCount - 1}*`;
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error fetching groups" });
    }
}

async function processCommand(sock, msg, sessionId) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption || "";
    
    if (!text || !text.startsWith('!')) return;
    
    const command = text.trim().toLowerCase();
    
    if (command === '!ping') await handlePingCommand(sock, from, sessionId);
    else if (command === '!jid') await handleJidCommand(sock, from, sessionId);
    else if (command === '!gjid') await handleGjidCommand(sock, from, sessionId);
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            return existing;
        }
        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

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
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            if (statusCode !== DisconnectReason.loggedOut && statusCode !== 440) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
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
            wasi_msg.message.videoMessage?.caption || "";

        const currentSession = sessions.get(sessionId);
        if (!currentSession) return;

        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg, sessionId);
        }

        if (currentSession.config.sourceJids.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message, currentSession.config);
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;

                const isMedia = relayMsg.imageMessage || relayMsg.videoMessage || 
                               relayMsg.audioMessage || relayMsg.documentMessage || relayMsg.stickerMessage;

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

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        config: {
            sourceJids: sessionConfig?.sourceJids || [],
            targetJids: sessionConfig?.targetJids || [],
            oldTextRegex: sessionConfig?.oldTextRegex?.map(r => r.source) || [],
            newText: sessionConfig?.newText || '',
            configSource: sessionConfig?_source || 'none'
        },
        activeSessions: Array.from(sessions.keys()),
        databaseConnected: mongoose.connection.readyState === 1
    });
});

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

wasi_app.post('/api/config', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const { sourceJids, targetJids, oldTextRegex, newText } = req.body;

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

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
                        return null;
                    }
                })
                .filter(regex => regex !== null);
        }
        if (newText !== undefined) {
            updatedConfig.newText = newText;
        }
        
        updatedConfig._source = 'api';

        const saveResult = await saveConfigForSession(sessionId, updatedConfig);
        session.config = updatedConfig;

        res.json({ 
            success: true, 
            message: `Configuration saved for session: ${sessionId}`,
            sessionId,
            savedToMongo: saveResult.savedToMongo,
            savedToJson: saveResult.savedToJson
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

wasi_app.post('/api/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    try {
        await startSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} started` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

wasi_app.post('/api/session/stop', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

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

wasi_app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
        sessionId: id,
        connected: data.isConnected,
        sourceCount: data.config?.sourceJids?.length || 0,
        targetCount: data.config?.targetJids?.length || 0
    }));
    res.json({ sessions: sessionList });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Multi-session WhatsApp Bot`);
        console.log(`📋 Default config: ${DEFAULT_SOURCE_JIDS.length} sources, ${DEFAULT_TARGET_JIDS.length} targets\n`);
    });
}

async function main() {
    if (config.mongoDbUrl) {
        try {
            await mongoose.connect(config.mongoDbUrl);
            console.log('✅ MongoDB Connected');
        } catch (error) {
            console.error('MongoDB connection error:', error);
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);
    wasi_startServer();
}

main();
