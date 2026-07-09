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

// -----------------------------------------------------------------------------
// CRASH PROTECTION — ek bhi unhandled error se pura bot "stuck"/crash na ho
// -----------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err);
});

/**
 * Kisi bhi promise ko timeout ke sath wrap karta hai. Agar WhatsApp server
 * response na de to yeh hamesha ke liye latakne ki bajaye ek fixed waqt ke
 * baad reject ho jata hai — isi wajah se pehle bot "stuck" ho jata tha.
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        )
    ]);
}

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
// STATUS REACTION CONFIGURATION
// -----------------------------------------------------------------------------

// Multiple emojis for random reaction
const REACTION_EMOJIS = process.env.REACTION_EMOJIS
    ? process.env.REACTION_EMOJIS.split(',')
    : ['❤️', '😍', '🔥', '👏', '👍', '💯', '✨', '🌟', '💪', '🎉'];

// Get random emoji from array
function getRandomEmoji() {
    return REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
}

// Track reacted statuses to avoid duplicate reactions
const reactedStatuses = new Set();

// Clean old entries from reactedStatuses (to prevent memory leak)
setInterval(() => {
    if (reactedStatuses.size > 10000) {
        reactedStatuses.clear();
        console.log('🧹 Cleared reacted statuses cache');
    }
}, 3600000); // Clear every hour

// -----------------------------------------------------------------------------
// STATUS QUEUE — jab ek sath multiple statuses aayen to unhe ek line me
// process karta hai (WhatsApp ko flood karne se rate-limit/silent-drop ho
// sakta hai), lekin har item timeout-protected hai isliye ek stuck status
// baaqi sab ko block nahi karega.
// -----------------------------------------------------------------------------
const statusQueue = [];
let isProcessingStatusQueue = false;

async function processStatusQueue(sock) {
    if (isProcessingStatusQueue) return;
    isProcessingStatusQueue = true;

    while (statusQueue.length > 0) {
        const queuedMsg = statusQueue.shift();
        try {
            await withTimeout(reactToStatus(sock, queuedMsg), 15000, 'Status reaction');
        } catch (err) {
            console.error('⚠️ Status queue item failed/timed out:', err.message);
        }
    }

    isProcessingStatusQueue = false;
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
// STATUS REACTION HANDLER
// -----------------------------------------------------------------------------

/**
 * Handle status reactions (stories)
 * Fix notes:
 *  - Sirf asal status@broadcast messages ko process karo (pehle wala check
 *    normal chat messages ko bhi status samajh raha tha).
 *  - Apni khud ki status ko react na karo (fromMe check missing tha).
 *  - Reaction hamesha 'status@broadcast' JID par bhejni hoti hai, sath
 *    statusJidList ke, na ke seedha sender ke JID par (yehi asal bug tha
 *    jiski wajah se reaction fail ho rahi thi).
 */

/**
 * WhatsApp ke naye "@lid" (Linked ID) privacy system ki wajah se, kuch senders
 * ka JID phone number ki bajaye "xxxxx@lid" format me aata hai. Reaction bhejte
 * waqt agar statusJidList me @lid diya jaye to WhatsApp server reaction ko
 * silently drop kar deta hai (koi error nahi aati, lekin reaction dikhta bhi
 * nahi). Yeh function @lid ko asal phone-number JID (@s.whatsapp.net) me
 * convert karne ki koshish karta hai. Agar resolve na ho sake to original
 * JID hi wapas kar deta hai (fallback).
 */
async function resolveRealJid(sock, jid) {
    if (!jid || !jid.endsWith('@lid')) return jid;
    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
        if (pn) {
            console.log(`🔄 Resolved LID ${jid} → ${pn}`);
            return pn;
        }
    } catch (e) {
        console.error('LID resolve error:', e);
    }
    return jid;
}

/**
 * Entry point — sirf validate karke queue me daal deta hai (fast, non-blocking).
 * Fix notes:
 *  - Sirf asal status@broadcast messages ko process karo (pehle wala check
 *    normal chat messages ko bhi status samajh raha tha).
 *  - Apni khud ki status ko react na karo (fromMe check missing tha).
 *  - Reaction hamesha 'status@broadcast' JID par bhejni hoti hai, sath
 *    statusJidList ke, na ke seedha sender ke JID par.
 *  - Multiple statuses ek sath aayen to queue serialize karti hai, lekin
 *    koi bhi mosconi-artificial delay nahi — isliye fast.
 *  - Har status timeout-protected hai — kabhi "stuck" nahi hoga.
 */
async function handleStatusReaction(sock, msg) {
    if (msg.key.remoteJid !== 'status@broadcast') return;
    if (msg.key.fromMe) return;
    if (!msg.key.participant) return;

    statusQueue.push(msg);
    // Fire-and-forget: queue processor khud sequentially chalata hai
    processStatusQueue(sock).catch(err => console.error('Queue processor error:', err));
}

/**
 * WhatsApp ke naye "@lid" (Linked ID) privacy system ki wajah se, kuch senders
 * ka JID phone number ki bajaye "xxxxx@lid" format me aata hai. Reaction bhejte
 * waqt agar statusJidList me @lid diya jaye to WhatsApp server reaction ko
 * silently drop kar deta hai (koi error nahi aati, lekin reaction dikhta bhi
 * nahi). Yeh function @lid ko asal phone-number JID (@s.whatsapp.net) me
 * convert karne ki koshish karta hai. Agar resolve na ho sake to original
 * JID hi wapas kar deta hai (fallback).
 */
async function resolveRealJid(sock, jid) {
    if (!jid || !jid.endsWith('@lid')) return jid;
    try {
        const pn = await withTimeout(
            sock.signalRepository?.lidMapping?.getPNForLID?.(jid) ?? Promise.resolve(null),
            4000,
            'LID resolve'
        );
        if (pn) {
            console.log(`🔄 Resolved LID ${jid} → ${pn}`);
            return pn;
        }
    } catch (e) {
        console.error('LID resolve error:', e.message);
    }
    return jid;
}

/**
 * Asal reaction logic — koi artificial sleep nahi (speed ke liye), har
 * WhatsApp-facing call timeout ke sath wrapped hai.
 */
async function reactToStatus(sock, msg) {
    const sender = msg.key.participant;
    const statusId = `${sender}_${msg.key.id}`;

    // Check if already reacted to this status
    if (reactedStatuses.has(statusId)) {
        console.log(`⏭️ Already reacted to status from ${sender}`);
        return;
    }

    const statusJidList = [
        await resolveRealJid(sock, sender),
        await resolveRealJid(sock, jidNormalizedUser(sock.user.id))
    ];

    // Status ko "seen" mark karo (blue tick) — fail ho to bhi reaction try karo
    try {
        await withTimeout(sock.readMessages([msg.key]), 8000, 'readMessages');
        console.log(`👀 Marked status as seen from ${sender}`);
    } catch (seenError) {
        console.error('Seen/read error:', seenError.message);
    }

    const emoji = getRandomEmoji();

    // Send reaction — must target status@broadcast with statusJidList
    await withTimeout(
        sock.sendMessage(
            'status@broadcast',
            { react: { text: emoji, key: msg.key } },
            { statusJidList }
        ),
        10000,
        'sendMessage reaction'
    );

    // Mark as reacted
    reactedStatuses.add(statusId);
    console.log(`✅ Reacted with ${emoji} to status from ${sender}`);
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

    // Fix: request status updates on socket connect so status@broadcast
    // messages actually arrive in messages.upsert
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

            // Fix: mark ourselves online so status broadcast events are received
            try {
                await wasi_sock.sendPresenceUpdate('available');
            } catch (e) {
                console.error('Presence update failed:', e);
            }
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // MESSAGE HANDLER - Status Reactions + Commands
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        try {
            // Fix: sirf naye/live messages process karo, history sync ignore karo
            if (wasi_m.type !== 'notify') return;

            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg || !wasi_msg.message) return;

            const wasi_text = wasi_msg.message.conversation ||
                wasi_msg.message.extendedTextMessage?.text ||
                wasi_msg.message.imageMessage?.caption ||
                wasi_msg.message.videoMessage?.caption ||
                wasi_msg.message.documentMessage?.caption || "";

            // COMMAND HANDLER (for !ping, !jid, !gjid)
            // Fix: sirf normal chats me commands chalao, status me nahi
            if (wasi_msg.key.remoteJid !== 'status@broadcast' && wasi_text.startsWith('!')) {
                await processCommand(wasi_sock, wasi_msg);
            }

            // STATUS REACTION HANDLER
            await handleStatusReaction(wasi_sock, wasi_msg);
        } catch (error) {
            console.error('messages.upsert handler error:', error);
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
        reactionEmojis: REACTION_EMOJIS
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
        console.log(`🎭 Status Reaction Bot Active`);
        console.log(`📱 Reacting to ALL statuses (Images, Videos, Text)`);
        console.log(`🎨 Random Emojis: ${REACTION_EMOJIS.join(', ')}`);
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
