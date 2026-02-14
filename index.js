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
// MONGODB CONFIG SCHEMA - YEH DATABASE MEIN SAVE HOGA
// -----------------------------------------------------------------------------
const ConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'botConfig' },
    sourceJids: [String],
    targetJids: [String],
    oldTextRegex: [String],
    newText: String,
    updatedAt: { type: Date, default: Date.now }
});

const BotConfig = mongoose.model('BotConfig', ConfigSchema);

// -----------------------------------------------------------------------------
// PERSISTENT CONFIGURATION LOAD - MONGODB SE LOAD HOGA
// -----------------------------------------------------------------------------
let SOURCE_JIDS = [];
let TARGET_JIDS = [];
let OLD_TEXT_REGEX = [];
let NEW_TEXT = '';

// Pehle MongoDB se load karne ki koshish
async function loadConfigFromDB() {
    try {
        if (mongoose.connection.readyState === 1) { // Connected
            const dbConfig = await BotConfig.findOne({ key: 'botConfig' });
            if (dbConfig) {
                SOURCE_JIDS = dbConfig.sourceJids || [];
                TARGET_JIDS = dbConfig.targetJids || [];
                NEW_TEXT = dbConfig.newText || '';
                
                // Regex patterns ko RegExp objects mein convert karo
                if (dbConfig.oldTextRegex) {
                    OLD_TEXT_REGEX = dbConfig.oldTextRegex.map(pattern => {
                        try {
                            return pattern ? new RegExp(pattern, 'gu') : null;
                        } catch (e) {
                            console.error(`Invalid regex pattern: ${pattern}`, e);
                            return null;
                        }
                    }).filter(regex => regex !== null);
                }
                
                console.log('✅ Config loaded from MongoDB');
                return true;
            }
        }
    } catch (e) {
        console.error('Failed to load from MongoDB:', e);
    }
    return false;
}

// Agar MongoDB se na mile to botConfig.json se load karo
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        
        Object.assign(config, savedConfig);
        
        if (savedConfig.SOURCE_JIDS) SOURCE_JIDS = savedConfig.SOURCE_JIDS;
        if (savedConfig.TARGET_JIDS) TARGET_JIDS = savedConfig.TARGET_JIDS;
        if (savedConfig.NEW_TEXT) NEW_TEXT = savedConfig.NEW_TEXT;
        
        if (savedConfig.OLD_TEXT_REGEX) {
            OLD_TEXT_REGEX = savedConfig.OLD_TEXT_REGEX.map(pattern => {
                try {
                    return pattern ? new RegExp(pattern, 'gu') : null;
                } catch (e) {
                    console.error(`Invalid regex pattern: ${pattern}`, e);
                    return null;
                }
            }).filter(regex => regex !== null);
        }
        
        console.log('✅ Config loaded from botConfig.json');
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

// Agar kuch na mile to env se load karo
if (SOURCE_JIDS.length === 0 && process.env.SOURCE_JIDS) {
    SOURCE_JIDS = process.env.SOURCE_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (TARGET_JIDS.length === 0 && process.env.TARGET_JIDS) {
    TARGET_JIDS = process.env.TARGET_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (OLD_TEXT_REGEX.length === 0 && process.env.OLD_TEXT_REGEX) {
    OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
    }).filter(regex => regex !== null);
}
if (NEW_TEXT === '' && process.env.NEW_TEXT) {
    NEW_TEXT = process.env.NEW_TEXT;
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
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
}

async function handleGjidCommand(sock, from) {
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
        if (command === '!ping') await handlePingCommand(sock, from);
        else if (command === '!jid') await handleJidCommand(sock, from);
        else if (command === '!gjid') await handleGjidCommand(sock, from);
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

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Forwarded to ${targetJid}`);
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

    // Database connection status
    const dbConnected = mongoose.connection.readyState === 1;

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        activeSessions: Array.from(sessions.keys()),
        databaseConnected: dbConnected
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// CONFIGURATION API - MONGODB MEIN SAVE HOGA
// -----------------------------------------------------------------------------

// GET current config
wasi_app.get('/api/config', (req, res) => {
    res.json({
        sourceJids: SOURCE_JIDS,
        targetJids: TARGET_JIDS,
        oldTextRegex: OLD_TEXT_REGEX.map(regex => regex.source),
        newText: NEW_TEXT
    });
});

// POST updated config - YEH MONGODB MEIN SAVE KAREGA
wasi_app.post('/api/config', async (req, res) => {
    try {
        const { sourceJids, targetJids, oldTextRegex, newText } = req.body;

        // Update variables
        if (sourceJids) SOURCE_JIDS = sourceJids.filter(s => s && s.trim());
        if (targetJids) TARGET_JIDS = targetJids.filter(s => s && s.trim());
        if (oldTextRegex) {
            OLD_TEXT_REGEX = oldTextRegex
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
        if (newText !== undefined) NEW_TEXT = newText;

        // Save to MongoDB
        if (mongoose.connection.readyState === 1) {
            await BotConfig.findOneAndUpdate(
                { key: 'botConfig' },
                {
                    sourceJids: SOURCE_JIDS,
                    targetJids: TARGET_JIDS,
                    oldTextRegex: OLD_TEXT_REGEX.map(r => r.source),
                    newText: NEW_TEXT,
                    updatedAt: new Date()
                },
                { upsert: true }
            );
            console.log('✅ Config saved to MongoDB');
        }

        // Also save to botConfig.json as backup
        const configToSave = {
            SOURCE_JIDS,
            TARGET_JIDS,
            OLD_TEXT_REGEX: OLD_TEXT_REGEX.map(r => r.source),
            NEW_TEXT,
            lastUpdated: new Date().toISOString()
        };
        
        fs.writeFileSync(
            path.join(__dirname, 'botConfig.json'),
            JSON.stringify(configToSave, null, 2)
        );

        // Update process.env
        process.env.SOURCE_JIDS = SOURCE_JIDS.join(',');
        process.env.TARGET_JIDS = TARGET_JIDS.join(',');
        process.env.OLD_TEXT_REGEX = OLD_TEXT_REGEX.map(r => r.source).join(',');
        process.env.NEW_TEXT = NEW_TEXT;

        res.json({ success: true, message: 'Configuration saved to MongoDB!' });
    } catch (error) {
        console.error('Config save error:', error);
        res.json({ success: false, error: error.message });
    }
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`📝 New Text: ${NEW_TEXT || 'Not set'}`);
        console.log(`💾 Config saved to MongoDB`);
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
            
            // Load config from MongoDB
            await loadConfigFromDB();
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
