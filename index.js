require('dotenv').config();
const {
DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const { promisify } = require('util');
const stream = require('stream');
const finished = promisify(stream.finished);

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// TELEGRAM BOT SETUP
// -----------------------------------------------------------------------------
let telegramBot = null;
const telegramEnabled = process.env.TELEGRAM_ENABLED === 'true' || false;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramAllowedChats = process.env.TELEGRAM_ALLOWED_CHATS ? 
    process.env.TELEGRAM_ALLOWED_CHATS.split(',').map(id => id.trim()) : [];
const telegramTargetJids = process.env.TELEGRAM_TARGET_JIDS ?
    process.env.TELEGRAM_TARGET_JIDS.split(',').map(jid => jid.trim()) : [];

// Create temp directory
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS (صرف یہ تین کمانڈز)
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
    const messages = [
        "Janu 🥹",
        "Love 😘 You",
        "Do You Love Me 🥹",
        "Please 🥺",
        "🙃🙂"
    ];
    for (const msg of messages) { 
        await sock.sendMessage(from, { text: msg }); 
        await new Promise(resolve => setTimeout(resolve, 100)); 
    } 
    console.log(`Ping command executed for ${from}`); 
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
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
            response += `${groupCount}. *${groupName}*\n`; 
            response += ` 👥 Members: ${participantsCount}\n`; 
            response += ` 🆔: \`${jid}\`\n`; 
            response += ` ──────────────\n\n`; 
            groupCount++; 
        } 
        if (groupCount === 1) { 
            response = "❌ No groups found."; 
        } else { 
            response += `\n*Total Groups: ${groupCount - 1}*`; 
        } 
        await sock.sendMessage(from, { text: response }); 
        console.log(`GJID command executed. Sent ${groupCount - 1} groups.`); 
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

    if (!text || !text.startsWith('!')) return; 

    const command = text.trim().toLowerCase(); 
    try { 
        if (command === '!ping') { 
            await handlePingCommand(sock, from); 
        } else if (command === '!jid') { 
            await handleJidCommand(sock, from); 
        } else if (command === '!gjid') { 
            await handleGjidCommand(sock, from); 
        } 
    } catch (error) { 
        console.error('Command execution error:', error); 
    } 
}

// -----------------------------------------------------------------------------
// TELEGRAM BOT FUNCTIONS
// -----------------------------------------------------------------------------

async function downloadTelegramFile(fileId, fileExt) {
    try {
        const fileLink = await telegramBot.telegram.getFileLink(fileId);
        const tempPath = path.join(tempDir, `telegram_${Date.now()}.${fileExt}`);
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({
            method: 'get',
            url: fileLink.href,
            responseType: 'stream'
        });
        response.data.pipe(writer);
        await finished(writer);
        return tempPath;
    } catch (error) {
        console.error('Error downloading:', error);
        return null;
    }
}

function isTelegramAuthorized(ctx) {
    const chatId = ctx.chat?.id?.toString();
    const fromId = ctx.from?.id?.toString();
    if (!telegramAllowedChats || telegramAllowedChats.length === 0) return true;
    return telegramAllowedChats.includes(chatId) || telegramAllowedChats.includes(fromId);
}

async function sendToWhatsApp(mediaType, filePath, caption = '') {
    try {
        const session = sessions.get(config.sessionId || 'wasi_session');
        if (!session || !session.sock || !session.isConnected) return false;

        const sock = session.sock;
        let message = {};

        switch(mediaType) {
            case 'photo':
                message = { image: { url: filePath }, caption };
                break;
            case 'video':
                message = { video: { url: filePath }, caption };
                break;
            case 'document':
                message = { document: { url: filePath }, caption, fileName: path.basename(filePath) };
                break;
            case 'audio':
                message = { audio: { url: filePath }, ptt: false };
                break;
            case 'voice':
                message = { audio: { url: filePath }, ptt: true };
                break;
            default:
                message = { text: caption };
        }

        for (const targetJid of telegramTargetJids) {
            await sock.sendMessage(targetJid, message);
        }

        fs.unlink(filePath, () => {});
        return true;
    } catch (error) {
        console.error('Error sending:', error);
        return false;
    }
}

async function startTelegramBot() {
    if (!telegramEnabled || !telegramToken) {
        console.log('⚠️ Telegram bot disabled');
        return;
    }

    try {
        telegramBot = new Telegraf(telegramToken);

        telegramBot.start((ctx) => {
            if (!isTelegramAuthorized(ctx)) return ctx.reply('⛔ Unauthorized');
            ctx.reply('✅ WhatsApp Bot Connected!\n\nSend me any media to forward to WhatsApp.');
        });

        telegramBot.on('text', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            if (!telegramTargetJids.length) return ctx.reply('❌ No WhatsApp targets');
            
            const session = sessions.get(config.sessionId || 'wasi_session');
            if (!session || !session.sock || !session.isConnected) {
                return ctx.reply('❌ WhatsApp not connected');
            }

            for (const targetJid of telegramTargetJids) {
                await session.sock.sendMessage(targetJid, { text: ctx.message.text });
            }
            ctx.reply(`✅ Message sent to WhatsApp`);
        });

        telegramBot.on('photo', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading...');
            const filePath = await downloadTelegramFile(photo.file_id, 'jpg');
            if (filePath) {
                await sendToWhatsApp('photo', filePath, caption);
                ctx.reply('✅ Photo sent to WhatsApp');
            }
        });

        telegramBot.on('video', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            const video = ctx.message.video;
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading...');
            const filePath = await downloadTelegramFile(video.file_id, 'mp4');
            if (filePath) {
                await sendToWhatsApp('video', filePath, caption);
                ctx.reply('✅ Video sent to WhatsApp');
            }
        });

        telegramBot.on('document', async (ctx) => {
            if (!isTelegramAuthorized(ctx)) return;
            const document = ctx.message.document;
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading...');
            const fileExt = document.file_name ? document.file_name.split('.').pop() : 'bin';
            const filePath = await downloadTelegramFile(document.file_id, fileExt);
            if (filePath) {
                await sendToWhatsApp('document', filePath, caption);
                ctx.reply('✅ Document sent to WhatsApp');
            }
        });

        telegramBot.launch();
        console.log('🤖 Telegram bot started');
        console.log(`📱 Allowed chats: ${telegramAllowedChats.length ? telegramAllowedChats.join(', ') : 'All'}`);
        console.log(`🎯 WhatsApp targets: ${telegramTargetJids.length ? telegramTargetJids.join(', ') : 'None'}`);

    } catch (error) {
        console.error('Telegram bot error:', error);
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;
        if (existing.sock) existing.sock.end();
        sessions.delete(sessionId);
    } 

    console.log(`🚀 Starting session: ${sessionId}`); 
    const sessionState = { sock: null, isConnected: false, qr: null }; 
    sessions.set(sessionId, sessionState); 

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId); 
    sessionState.sock = wasi_sock; 

    wasi_sock.ev.on('connection.update', async (update) => { 
        const { connection, lastDisconnect, qr } = update; 
        if (qr) { 
            sessionState.qr = qr; 
            console.log(`QR generated for session: ${sessionId}`); 
        } 
        if (connection === 'close') { 
            sessionState.isConnected = false; 
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500; 
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startSession(sessionId), 3000); 
            } else {
                sessions.delete(sessionId); 
                await wasi_clearSession(sessionId); 
            }
        } else if (connection === 'open') { 
            sessionState.isConnected = true; 
            sessionState.qr = null; 
            console.log(`✅ ${sessionId}: Connected to WhatsApp`); 
            if (telegramEnabled && telegramToken && !telegramBot) {
                await startTelegramBot();
            }
        } 
    }); 

    wasi_sock.ev.on('creds.update', saveCreds); 

    // صرف کمانڈز کے لیے
    wasi_sock.ev.on('messages.upsert', async wasi_m => { 
        const wasi_msg = wasi_m.messages[0]; 
        if (!wasi_msg.message) return; 
        const wasi_text = wasi_msg.message.conversation || 
                        wasi_msg.message.extendedTextMessage?.text || 
                        wasi_msg.message.imageMessage?.caption || 
                        wasi_msg.message.videoMessage?.caption || ""; 
        if (wasi_text.startsWith('!')) { 
            await processCommand(wasi_sock, wasi_msg); 
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
            try { qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 }); } catch (e) {} 
        } 
    } 
    res.json({ 
        sessionId, connected, qr: qrDataUrl,
        telegram: {
            enabled: telegramEnabled,
            botRunning: telegramBot !== null,
            allowedChats: telegramAllowedChats,
            targetJids: telegramTargetJids
        }
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
        console.log(`\n🤖 Telegram Bot:`);
        console.log(` • Enabled: ${telegramEnabled ? '✅' : '❌'}`);
        console.log(`🤖 WhatsApp Commands: !ping, !jid, !gjid`);
    }); 
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }
    const sessionId = config.sessionId || 'wasi_session'; 
    await startSession(sessionId); 
    wasi_startServer(); 
}

main();
