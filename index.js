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
const os = require('os');
const cluster = require('cluster');

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
// PERFORMANCE OPTIMIZATIONS (compression hata diya)
// -----------------------------------------------------------------------------

// Cache for QR codes
const qrCache = new Map();
const QR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Message queue for better performance
const messageQueue = [];
let isProcessingQueue = false;

// Session state with optimizations
const sessions = new Map();

// Middleware with optimizations
wasi_app.use(express.json({ limit: '50mb' }));
wasi_app.use(express.urlencoded({ extended: true, limit: '50mb' }));
wasi_app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true
}));

// Keep-Alive Route with minimal response
wasi_app.get('/ping', (req, res) => res.status(200).end('pong'));

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION (OPTIMIZED)
// -----------------------------------------------------------------------------
const SOURCE_JIDS = new Set(process.env.SOURCE_JIDS ? process.env.SOURCE_JIDS.split(',') : []);
const TARGET_JIDS = process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',') : [];

// Pre-compile regex patterns
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

const NEW_TEXT = process.env.NEW_TEXT || '';

// -----------------------------------------------------------------------------
// OPTIMIZED MESSAGE CLEANING FUNCTIONS
// -----------------------------------------------------------------------------

// Pre-compiled regex patterns
const NEWSLETTER_PATTERNS = [
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

const EMOJI_REGEX = /^(?:\p{Extended_Pictographic}|\s)+$/u;

/**
 * Fast message cloning using Object.assign
 */
function fastClone(obj) {
    return Object.assign({}, obj);
}

/**
 * Optimized forwarded label cleaner
 */
function cleanForwardedLabelFast(message) {
    if (!message) return message;
    
    // Direct property access for better performance
    const msgTypes = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
    
    for (const type of msgTypes) {
        const msg = message[type];
        if (msg?.contextInfo) {
            msg.contextInfo.isForwarded = false;
            if (msg.contextInfo.forwardingScore) {
                msg.contextInfo.forwardingScore = 0;
            }
        }
    }
    
    return message;
}

/**
 * Optimized text cleaner
 */
function cleanNewsletterTextFast(text) {
    if (!text || typeof text !== 'string') return text;
    
    let cleaned = text;
    for (const pattern of NEWSLETTER_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
    }
    
    return cleaned.trim();
}

/**
 * Optimized caption replacement
 */
function replaceCaptionFast(caption) {
    if (!caption || !OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    for (const regex of OLD_TEXT_REGEX) {
        result = result.replace(regex, NEW_TEXT);
    }
    
    return result;
}

/**
 * Ultra-fast message processor
 */
function processMessageFast(originalMsg) {
    try {
        // Early return for non-forwardable messages
        if (!originalMsg) return null;
        
        // Handle view-once messages
        if (originalMsg.viewOnceMessageV2) {
            originalMsg = originalMsg.viewOnceMessageV2.message;
        } else if (originalMsg.viewOnceMessage) {
            originalMsg = originalMsg.viewOnceMessage.message;
        }
        
        // Check for media or emoji
        const isMedia = !!(originalMsg.imageMessage || 
                          originalMsg.videoMessage || 
                          originalMsg.audioMessage || 
                          originalMsg.documentMessage || 
                          originalMsg.stickerMessage);
        
        if (!isMedia) {
            // Check for emoji-only text
            const text = originalMsg.conversation || 
                        originalMsg.extendedTextMessage?.text || '';
            
            if (!text || !EMOJI_REGEX.test(text)) {
                return null;
            }
        }
        
        // Clean the message
        const cleanedMsg = cleanForwardedLabelFast(originalMsg);
        
        // Clean text if present
        if (cleanedMsg.conversation) {
            cleanedMsg.conversation = cleanNewsletterTextFast(cleanedMsg.conversation);
        }
        
        // Handle captions
        if (cleanedMsg.imageMessage?.caption) {
            cleanedMsg.imageMessage.caption = replaceCaptionFast(
                cleanNewsletterTextFast(cleanedMsg.imageMessage.caption)
            );
        }
        if (cleanedMsg.videoMessage?.caption) {
            cleanedMsg.videoMessage.caption = replaceCaptionFast(
                cleanNewsletterTextFast(cleanedMsg.videoMessage.caption)
            );
        }
        if (cleanedMsg.documentMessage?.caption) {
            cleanedMsg.documentMessage.caption = replaceCaptionFast(
                cleanNewsletterTextFast(cleanedMsg.documentMessage.caption)
            );
        }
        
        // Remove protocol messages
        if (cleanedMsg.protocolMessage) {
            delete cleanedMsg.protocolMessage;
        }
        
        return cleanedMsg;
        
    } catch (error) {
        console.error('Fast processing error:', error);
        return null;
    }
}

// -----------------------------------------------------------------------------
// MESSAGE QUEUE PROCESSOR
// -----------------------------------------------------------------------------
async function processMessageQueue(sock) {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (messageQueue.length > 0) {
        const { processedMsg, targetJids } = messageQueue.shift();
        
        // Send to all targets in parallel
        await Promise.allSettled(
            targetJids.map(targetJid =>
                sock.relayMessage(targetJid, processedMsg, {
                    messageId: sock.generateMessageTag()
                }).catch(err => {
                    console.error(`Failed to send to ${targetJid}:`, err.message);
                })
            )
        );
    }
    
    isProcessingQueue = false;
}

// -----------------------------------------------------------------------------
// COMMAND HANDLERS (OPTIMIZED)
// -----------------------------------------------------------------------------

const COMMAND_HANDLERS = {
    '!ping': async (sock, from) => {
        await sock.sendMessage(from, { text: "Love You😘" });
    },
    '!jid': async (sock, from) => {
        await sock.sendMessage(from, { text: from });
    },
    '!gjid': async (sock, from) => {
        try {
            const groups = await sock.groupFetchAllParticipating();
            
            let response = "📌 *Groups List:*\n\n";
            let groupCount = 1;
            
            for (const [jid, group] of Object.entries(groups)) {
                const groupName = group.subject || "Unnamed Group";
                const participantsCount = group.participants?.length || 0;
                
                let groupType = "Simple Group";
                if (group.isCommunity) groupType = "Community";
                else if (group.isCommunityAnnounce) groupType = "Community Announcement";
                else if (group.parentGroup) groupType = "Subgroup";
                
                response += `${groupCount}. *${groupName}*\n`;
                response += `   👥 Members: ${participantsCount}\n`;
                response += `   🆔: \`${jid}\`\n`;
                response += `   📝 Type: ${groupType}\n`;
                response += `   ──────────────\n\n`;
                
                groupCount++;
            }
            
            response = groupCount === 1 
                ? "❌ No groups found." 
                : response + `\n*Total Groups: ${groupCount - 1}*`;
            
            await sock.sendMessage(from, { text: response });
            
        } catch (error) {
            console.error('Error fetching groups:', error);
            await sock.sendMessage(from, { 
                text: "❌ Error fetching groups list." 
            });
        }
    }
};

/**
 * Fast command processor
 */
async function processCommandFast(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                "";
    
    if (!text || !text.startsWith('!')) return;
    
    const handler = COMMAND_HANDLERS[text.trim().toLowerCase()];
    if (handler) {
        try {
            await handler(sock, from);
        } catch (error) {
            console.error('Command error:', error);
        }
    }
}

// -----------------------------------------------------------------------------
// OPTIMIZED SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    // Check existing session
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} already connected.`);
            return existing;
        }
        
        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0,
        lastActivity: Date.now(),
        messageCount: 0
    };
    
    sessions.set(sessionId, sessionState);

    // Connect with optimized settings
    const { wasi_sock, saveCreds } = await wasi_connectSession(true, sessionId);
    sessionState.sock = wasi_sock;

    // Connection update handler
    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
            
            // Cache QR
            try {
                qrCache.set(sessionId, await QRCode.toDataURL(qr, { width: 256 }));
                setTimeout(() => qrCache.delete(sessionId), QR_CACHE_TTL);
            } catch (e) {}
            
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
                qrCache.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
            
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Optimized message handler
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const msg = wasi_m.messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const origin = msg.key.remoteJid;
        sessionState.lastActivity = Date.now();
        sessionState.messageCount++;

        // Process commands
        await processCommandFast(wasi_sock, msg);

        // Auto-forward logic
        if (SOURCE_JIDS.has(origin)) {
            const processedMsg = processMessageFast(msg.message);
            
            if (processedMsg && TARGET_JIDS.length > 0) {
                // Add to queue instead of sending immediately
                messageQueue.push({
                    processedMsg,
                    targetJids: TARGET_JIDS
                });
                
                // Process queue if not already processing
                if (!isProcessingQueue) {
                    setImmediate(() => processMessageQueue(wasi_sock));
                }
            }
        }
    });

    return sessionState;
}

// -----------------------------------------------------------------------------
// OPTIMIZED API ROUTES
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let stats = null;

    if (session) {
        connected = session.isConnected;
        
        // Get cached QR or generate new
        if (session.qr) {
            qrDataUrl = qrCache.get(sessionId);
            if (!qrDataUrl) {
                try {
                    qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
                    qrCache.set(sessionId, qrDataUrl, QR_CACHE_TTL);
                } catch (e) {}
            }
        }
        
        stats = {
            messageCount: session.messageCount,
            lastActivity: session.lastActivity,
            uptime: Date.now() - (session.lastActivity || Date.now())
        };
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        stats,
        queueSize: messageQueue.length,
        activeSessions: Array.from(sessions.keys()),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
wasi_app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        sessions: sessions.size,
        queueSize: messageQueue.length,
        memory: process.memoryUsage().rss
    });
});

// -----------------------------------------------------------------------------
// SERVER START WITH OPTIMIZATIONS
// -----------------------------------------------------------------------------
function wasi_startServer() {
    const server = wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.size} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Optimizations: Queue system, Caching`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
        console.log(`⚡ Performance: Fast message processing enabled`);
    });

    // Increase timeout for better performance
    server.timeout = 120000; // 2 minutes
    server.keepAliveTimeout = 65000; // 65 seconds
}

// -----------------------------------------------------------------------------
// MAIN STARTUP WITH OPTIMIZATIONS
// -----------------------------------------------------------------------------
async function main() {
    // Set process priority
    process.title = 'wasi-bot';
    
    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
    });
    
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled Rejection:', err);
    });

    // Connect to database if configured
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

    // Periodic queue processing
    setInterval(() => {
        if (messageQueue.length > 0 && !isProcessingQueue) {
            const session = sessions.get(sessionId);
            if (session?.isConnected) {
                processMessageQueue(session.sock);
            }
        }
    }, 1000);

    // Memory cleanup every 5 minutes
    setInterval(() => {
        if (global.gc) {
            global.gc();
        }
    }, 300000);
}

// Start the application
main();
