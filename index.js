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
const { Worker } = require('worker_threads');
const QRCode = require('qrcode');
const Redis = require('ioredis');
const pLimit = require('p-limit');
const { Pool } = require('worker-threads-pool');

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
// PERFORMANCE OPTIMIZATION SETTINGS
// -----------------------------------------------------------------------------
const PERFORMANCE_CONFIG = {
    MAX_CONCURRENT_MESSAGES: 100, // Parallel messages processing
    BATCH_SIZE: 50, // Batch size for message forwarding
    MESSAGE_QUEUE_SIZE: 1000, // Queue size for messages
    WORKER_THREADS: os.cpus().length, // Use all CPU cores
    USE_CLUSTER: true, // Enable clustering
    USE_REDIS_CACHE: true, // Use Redis for caching
    MESSAGE_TIMEOUT: 5000, // 5 seconds timeout
    MAX_RETRIES: 3, // Max retry attempts
    CIRCUIT_BREAKER_THRESHOLD: 10, // Circuit breaker threshold
};

// -----------------------------------------------------------------------------
// ADVANCED CACHE SYSTEM
// -----------------------------------------------------------------------------
class PerformanceCache {
    constructor() {
        this.cache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            total: 0
        };
    }

    get(key) {
        this.stats.total++;
        const item = this.cache.get(key);
        if (item && Date.now() < item.expiry) {
            this.stats.hits++;
            return item.value;
        }
        this.stats.misses++;
        return null;
    }

    set(key, value, ttl = 60000) {
        this.cache.set(key, {
            value,
            expiry: Date.now() + ttl
        });
    }

    clear() {
        this.cache.clear();
    }

    getStats() {
        const hitRate = this.stats.total > 0 
            ? (this.stats.hits / this.stats.total * 100).toFixed(2) 
            : 0;
        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            size: this.cache.size
        };
    }
}

// -----------------------------------------------------------------------------
// MESSAGE QUEUE SYSTEM
// -----------------------------------------------------------------------------
class MessageQueue {
    constructor(maxConcurrent = PERFORMANCE_CONFIG.MAX_CONCURRENT_MESSAGES) {
        this.queue = [];
        this.processing = new Set();
        this.maxConcurrent = maxConcurrent;
        this.stats = {
            processed: 0,
            failed: 0,
            queueTime: 0
        };
    }

    async add(message, processor) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                message,
                processor,
                resolve,
                reject,
                timestamp: Date.now()
            });
            this.process();
        });
    }

    async process() {
        if (this.processing.size >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        const item = this.queue.shift();
        this.processing.add(item);

        try {
            const queueTime = Date.now() - item.timestamp;
            this.stats.queueTime = (this.stats.queueTime + queueTime) / 2;
            
            const result = await Promise.race([
                item.processor(item.message),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 
                    PERFORMANCE_CONFIG.MESSAGE_TIMEOUT)
                )
            ]);
            
            item.resolve(result);
            this.stats.processed++;
        } catch (error) {
            item.reject(error);
            this.stats.failed++;
        } finally {
            this.processing.delete(item);
            this.process(); // Process next item
        }
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            processingCount: this.processing.size
        };
    }
}

// -----------------------------------------------------------------------------
// CIRCUIT BREAKER
// -----------------------------------------------------------------------------
class CircuitBreaker {
    constructor(failureThreshold = PERFORMANCE_CONFIG.CIRCUIT_BREAKER_THRESHOLD, timeout = 30000) {
        this.failureThreshold = failureThreshold;
        this.timeout = timeout;
        this.failures = 0;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.nextAttempt = Date.now();
    }

    async call(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() > this.nextAttempt) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error('Circuit breaker is OPEN');
            }
        }

        try {
            const result = await fn();
            if (this.state === 'HALF_OPEN') {
                this.reset();
            }
            return result;
        } catch (error) {
            this.failures++;
            
            if (this.failures >= this.failureThreshold) {
                this.state = 'OPEN';
                this.nextAttempt = Date.now() + this.timeout;
            }
            
            throw error;
        }
    }

    reset() {
        this.failures = 0;
        this.state = 'CLOSED';
    }
}

// -----------------------------------------------------------------------------
// SESSION STATE WITH ADVANCED FEATURES
// -----------------------------------------------------------------------------
const sessions = new Map();
const messageQueue = new MessageQueue();
const cache = new PerformanceCache();
const circuitBreaker = new CircuitBreaker();

// Redis client for distributed caching (optional)
let redis;
if (PERFORMANCE_CONFIG.USE_REDIS_CACHE && process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    redis.on('error', (err) => console.error('Redis error:', err));
}

// Worker thread pool for CPU-intensive tasks
const workerPool = new Pool({ max: PERFORMANCE_CONFIG.WORKER_THREADS });

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Performance monitoring middleware
wasi_app.use((req, res, next) => {
    req.startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - req.startTime;
        console.log(`${req.method} ${req.url} - ${duration}ms`);
    });
    next();
});

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

// Pre-compiled regex patterns
const NEWSLETTER_MARKERS = [
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

// -----------------------------------------------------------------------------
// OPTIMIZED MESSAGE PROCESSING
// -----------------------------------------------------------------------------

/**
 * Ultra-fast message cleaning with caching
 */
function fastCleanMessage(message, cacheKey = null) {
    // Check cache first
    if (cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        // Use structuredClone for faster cloning (Node 17+)
        let cleanedMessage = structuredClone ? 
            structuredClone(message) : 
            JSON.parse(JSON.stringify(message));

        // Batch remove context info
        const messageTypes = [
            'extendedTextMessage',
            'imageMessage',
            'videoMessage',
            'audioMessage',
            'documentMessage'
        ];

        for (const type of messageTypes) {
            if (cleanedMessage[type]?.contextInfo) {
                cleanedMessage[type].contextInfo.isForwarded = false;
                cleanedMessage[type].contextInfo.forwardingScore = 0;
                
                // Clean participant info if needed
                if (cleanedMessage[type].contextInfo.participant?.includes('newsletter')) {
                    delete cleanedMessage[type].contextInfo.participant;
                    delete cleanedMessage[type].contextInfo.stanzaId;
                    delete cleanedMessage[type].contextInfo.remoteJid;
                }
            }
        }

        // Fast text cleaning
        const textFields = [
            'conversation',
            'extendedTextMessage?.text',
            'imageMessage?.caption',
            'videoMessage?.caption',
            'documentMessage?.caption'
        ];

        for (const field of textFields) {
            const value = getNestedValue(cleanedMessage, field);
            if (value) {
                const cleaned = fastCleanText(value);
                setNestedValue(cleanedMessage, field, cleaned);
            }
        }

        // Remove protocol messages
        delete cleanedMessage.protocolMessage;

        // Cache result
        if (cacheKey) {
            cache.set(cacheKey, cleanedMessage, 30000); // 30 seconds cache
        }

        return cleanedMessage;
    } catch (error) {
        console.error('Fast message cleaning error:', error);
        return message;
    }
}

/**
 * Helper functions for nested object access
 */
function getNestedValue(obj, path) {
    return path.split('?.').reduce((o, key) => o?.[key], obj);
}

function setNestedValue(obj, path, value) {
    const keys = path.split('?.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
}

/**
 * Fast text cleaning with pre-compiled regex
 */
function fastCleanText(text) {
    if (!text) return text;
    
    let cleaned = text;
    
    // Apply all newsletter markers in one pass
    for (const marker of NEWSLETTER_MARKERS) {
        cleaned = cleaned.replace(marker, '');
    }
    
    // Apply regex replacements if configured
    if (OLD_TEXT_REGEX.length && NEW_TEXT) {
        for (const regex of OLD_TEXT_REGEX) {
            cleaned = cleaned.replace(regex, NEW_TEXT);
        }
    }
    
    return cleaned.trim();
}

/**
 * Batch message processing
 */
async function processMessageBatch(messages, sock) {
    const batchPromises = [];
    const batchSize = PERFORMANCE_CONFIG.BATCH_SIZE;

    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        batchPromises.push(processBatch(batch, sock));
    }

    return Promise.all(batchPromises);
}

async function processBatch(batch, sock) {
    const results = [];
    
    for (const msg of batch) {
        try {
            const result = await processSingleMessage(msg, sock);
            results.push(result);
        } catch (error) {
            console.error('Batch processing error:', error);
        }
    }
    
    return results;
}

async function processSingleMessage(wasi_msg, wasi_sock) {
    const wasi_origin = wasi_msg.key.remoteJid;
    const wasi_text = wasi_msg.message.conversation ||
        wasi_msg.message.extendedTextMessage?.text ||
        wasi_msg.message.imageMessage?.caption ||
        wasi_msg.message.videoMessage?.caption ||
        wasi_msg.message.documentMessage?.caption || "";

    // COMMAND HANDLER - Fast path
    if (wasi_text.startsWith('!')) {
        await processCommand(wasi_sock, wasi_msg);
    }

    // AUTO FORWARD LOGIC - Skip if not in sources
    if (!SOURCE_JIDS.includes(wasi_origin) || wasi_msg.key.fromMe) {
        return;
    }

    // Create cache key
    const cacheKey = `msg_${wasi_msg.key.id}_${wasi_origin}`;
    
    // Fast message cleaning
    let relayMsg = fastCleanMessage(wasi_msg.message, cacheKey);

    if (!relayMsg) return;

    // View Once Unwrap
    if (relayMsg.viewOnceMessageV2)
        relayMsg = relayMsg.viewOnceMessageV2.message;
    if (relayMsg.viewOnceMessage)
        relayMsg = relayMsg.viewOnceMessage.message;

    // Fast media/emoji check
    const isMedia = relayMsg.imageMessage ||
        relayMsg.videoMessage ||
        relayMsg.audioMessage ||
        relayMsg.documentMessage ||
        relayMsg.stickerMessage;

    let isEmojiOnly = false;
    if (relayMsg.conversation) {
        isEmojiOnly = EMOJI_REGEX.test(relayMsg.conversation);
    }

    if (!isMedia && !isEmojiOnly) return;

    console.log(`📦 Fast forwarding from ${wasi_origin}`);

    // Parallel forwarding to all targets
    const forwardPromises = TARGET_JIDS.map(targetJid => 
        messageQueue.add(relayMsg, async (msg) => {
            return circuitBreaker.call(async () => {
                try {
                    await wasi_sock.relayMessage(
                        targetJid,
                        msg,
                        { 
                            messageId: wasi_sock.generateMessageTag(),
                            timeoutMs: PERFORMANCE_CONFIG.MESSAGE_TIMEOUT 
                        }
                    );
                    return { success: true, target: targetJid };
                } catch (err) {
                    console.error(`Failed to forward to ${targetJid}:`, err.message);
                    return { success: false, target: targetJid, error: err.message };
                }
            });
        })
    );

    return Promise.all(forwardPromises);
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS (Optimized)
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
        switch(command) {
            case '!ping':
                await handlePingCommand(sock, from);
                break;
            case '!jid':
                await handleJidCommand(sock, from);
                break;
            case '!gjid':
                await handleGjidCommand(sock, from);
                break;
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// CLUSTERED SESSION MANAGEMENT
// -----------------------------------------------------------------------------
if (cluster.isMaster && PERFORMANCE_CONFIG.USE_CLUSTER) {
    const numWorkers = PERFORMANCE_CONFIG.WORKER_THREADS;
    console.log(`Master cluster setting up ${numWorkers} workers...`);

    for (let i = 0; i < numWorkers; i++) {
        cluster.fork();
    }

    cluster.on('online', (worker) => {
        console.log(`Worker ${worker.process.pid} is online`);
    });

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
    });

} else {
    // Worker process - Run the actual bot
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

        console.log(`🚀 Starting session: ${sessionId} on worker ${process.pid}`);

        const sessionState = {
            sock: null,
            isConnected: false,
            qr: null,
            reconnectAttempts: 0,
            messageBuffer: [],
            lastFlush: Date.now()
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
                console.log(`✅ ${sessionId}: Connected to WhatsApp on worker ${process.pid}`);
            }
        });

        wasi_sock.ev.on('creds.update', saveCreds);

        // Optimized message handler with batching
        wasi_sock.ev.on('messages.upsert', async wasi_m => {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg.message) return;

            // Add to buffer for batch processing
            sessionState.messageBuffer.push(wasi_msg);

            // Process batch if buffer is full or time elapsed
            if (sessionState.messageBuffer.length >= PERFORMANCE_CONFIG.BATCH_SIZE || 
                Date.now() - sessionState.lastFlush > 100) {
                
                const batch = sessionState.messageBuffer;
                sessionState.messageBuffer = [];
                sessionState.lastFlush = Date.now();

                // Process batch without awaiting
                processMessageBatch(batch, wasi_sock).catch(console.error);
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
            activeSessions: Array.from(sessions.keys()),
            performance: {
                worker: process.pid,
                cache: cache.getStats(),
                queue: messageQueue.getStats(),
                circuitBreaker: {
                    state: circuitBreaker.state,
                    failures: circuitBreaker.failures
                }
            }
        });
    });

    wasi_app.get('/api/performance', (req, res) => {
        res.json({
            cache: cache.getStats(),
            queue: messageQueue.getStats(),
            config: PERFORMANCE_CONFIG
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
            console.log(`🌐 Worker ${process.pid} running on port ${wasi_port}`);
            console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
            console.log(`⚡ Performance Mode: 
                - Workers: ${PERFORMANCE_CONFIG.WORKER_THREADS}
                - Concurrent: ${PERFORMANCE_CONFIG.MAX_CONCURRENT_MESSAGES}
                - Batch Size: ${PERFORMANCE_CONFIG.BATCH_SIZE}
                - Cache: ${cache.getStats().hitRate} hit rate`);
        });
    }

    // -----------------------------------------------------------------------------
    // MAIN STARTUP
    // -----------------------------------------------------------------------------
    async function main() {
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
}
