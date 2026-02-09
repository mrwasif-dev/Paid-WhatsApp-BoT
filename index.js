require('dotenv').config();
const {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeWASocket,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');

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
const sessions = new Map();

wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

const SOURCE_JIDS = process.env.SOURCE_JIDS ? process.env.SOURCE_JIDS.split(',') : [];
const TARGET_JIDS = process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',') : [];

const OLD_TEXT_REGEX = /™✤͜🤍⃛⃟🇫.*?ʏ☆🇭.*?🏠/gu;
const NEW_TEXT = '💫 WA Social ~ Network ™  📡';

function replaceCaption(caption) {
    return caption ? caption.replace(OLD_TEXT_REGEX, NEW_TEXT) : caption;
}

async function connectSession(sessionId) {
    const authDir = path.join(__dirname, 'auth', sessionId);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: Browsers.macOS('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true
    });
    
    return { sock, saveCreds };
}

async function clearSession(sessionId) {
    const authDir = path.join(__dirname, 'auth', sessionId);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`🧹 Cleared session: ${sessionId}`);
        return true;
    }
    return false;
}

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Pong! 🏓" });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `📱 Current Chat JID:\n\`${from}\`` });
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
        
        if (groupCount === 1) response = "❌ No groups found.";
        else response += `\n*Total Groups: ${groupCount - 1}*`;
        
        await sock.sendMessage(from, { text: response });
        console.log(`GJID command executed. Sent ${groupCount - 1} groups list.`);
        
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { text: "❌ Error fetching groups list." });
    }
}

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith(config.prefix)) return;
    
    const command = text.trim().toLowerCase();
    
    try {
        if (command === `${config.prefix}ping`) await handlePingCommand(sock, from);
        else if (command === `${config.prefix}jid`) await handleJidCommand(sock, from);
        else if (command === `${config.prefix}gjid`) await handleGjidCommand(sock, from);
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

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

    const { sock, saveCreds } = await connectSession(sessionId);
    sessionState.sock = sock;

    sock.ev.on('connection.update', async (update) => {
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
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                console.log(`Session ${sessionId} logged out. Removing.`);
                sessions.delete(sessionId);
                await clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async wasi_m => {
        const msg = wasi_m.messages[0];
        if (!msg.message) return;

        const origin = msg.key.remoteJid;
        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption || "";

        if (text.startsWith(config.prefix)) await processCommand(sock, msg);

        if (SOURCE_JIDS.includes(origin) && !msg.key.fromMe) {
            try {
                let relayMsg = { ...msg.message };
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;

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

                if (relayMsg.imageMessage?.caption) relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                if (relayMsg.videoMessage?.caption) relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                if (relayMsg.documentMessage?.caption) relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);

                console.log(`📦 Forwarding from ${origin}`);

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await sock.relayMessage(targetJid, relayMsg, { messageId: sock.generateMessageTag() });
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

wasi_app.listen(wasi_port, () => {
    console.log(`🌐 Server running on port ${wasi_port}`);
    console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
    console.log(`🤖 Bot Commands: ${config.prefix}ping, ${config.prefix}jid, ${config.prefix}gjid`);
});

async function main() {
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);
}

main();
