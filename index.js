// MongoDB warnings کو مکمل خاموش کریں
process.env.MONGOOSE_DEPRECATION_WARNINGS = 'false';
process.env.NO_DEPRECATION = 'mongoose';

// تمام warnings کو فلٹر کریں
const originalEmit = process.emit;
process.emit = function (name, data, ...args) {
    if (name === 'warning' && 
        data && 
        data.name === 'MongooseWarning' && 
        data.message && 
        data.message.includes('findOneAndUpdate')) {
        return false;
    }
    return originalEmit.call(process, name, data, ...args);
};

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
// TELEGRAM BOT SETUP - PUBLIC ACCESS
// -----------------------------------------------------------------------------
let telegramBot = null;
const telegramEnabled = process.env.TELEGRAM_ENABLED === 'true' || false;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
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
// COMMAND HANDLER FUNCTIONS
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
// TELEGRAM BOT FUNCTIONS - PUBLIC ACCESS (کوئی authorization نہیں)
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

        // Start command - سب کے لیے کھلا
        telegramBot.start((ctx) => {
            ctx.reply('✅ *WhatsApp Bot Connected!*\n\n' +
                     'Send me any media or message and it will be forwarded to WhatsApp.\n\n' +
                     'Supported formats:\n' +
                     '• Photos 📸\n' +
                     '• Videos 🎥\n' +
                     '• Documents 📄\n' +
                     '• Audio 🎵\n' +
                     '• Voice Messages 🎤\n' +
                     '• Text Messages 💬', 
                     { parse_mode: 'Markdown' });
        });

        // Help command
        telegramBot.help((ctx) => {
            ctx.reply('Just send me any media or message!\n\n' +
                     'I will forward it to WhatsApp group.');
        });

        // Text messages - سب کے لیے کھلا
        telegramBot.on('text', async (ctx) => {
            if (!telegramTargetJids.length) {
                return ctx.reply('❌ No WhatsApp targets configured');
            }
            
            const session = sessions.get(config.sessionId || 'wasi_session');
            if (!session || !session.sock || !session.isConnected) {
                return ctx.reply('❌ WhatsApp not connected');
            }

            for (const targetJid of telegramTargetJids) {
                await session.sock.sendMessage(targetJid, { text: ctx.message.text });
            }
            ctx.reply(`✅ Message sent to WhatsApp`);
        });

        // Photos - سب کے لیے کھلا
        telegramBot.on('photo', async (ctx) => {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading photo...');
            const filePath = await downloadTelegramFile(photo.file_id, 'jpg');
            if (filePath) {
                await sendToWhatsApp('photo', filePath, caption);
                ctx.reply('✅ Photo sent to WhatsApp');
            }
        });

        // Videos - سب کے لیے کھلا
        telegramBot.on('video', async (ctx) => {
            const video = ctx.message.video;
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading video...');
            const filePath = await downloadTelegramFile(video.file_id, 'mp4');
            if (filePath) {
                await sendToWhatsApp('video', filePath, caption);
                ctx.reply('✅ Video sent to WhatsApp');
            }
        });

        // Documents - سب کے لیے کھلا
        telegramBot.on('document', async (ctx) => {
            const document = ctx.message.document;
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading document...');
            const fileExt = document.file_name ? document.file_name.split('.').pop() : 'bin';
            const filePath = await downloadTelegramFile(document.file_id, fileExt);
            if (filePath) {
                await sendToWhatsApp('document', filePath, caption);
                ctx.reply('✅ Document sent to WhatsApp');
            }
        });

        // Audio - سب کے لیے کھلا
        telegramBot.on('audio', async (ctx) => {
            const audio = ctx.message.audio;
            const caption = ctx.message.caption || '';
            ctx.reply('📥 Downloading audio...');
            const filePath = await downloadTelegramFile(audio.file_id, 'mp3');
            if (filePath) {
                await sendToWhatsApp('audio', filePath, caption);
                ctx.reply('✅ Audio sent to WhatsApp');
            }
        });

        // Voice - سب کے لیے کھلا
        telegramBot.on('voice', async (ctx) => {
            const voice = ctx.message.voice;
            ctx.reply('📥 Downloading voice message...');
            const filePath = await downloadTelegramFile(voice.file_id, 'ogg');
            if (filePath) {
                await sendToWhatsApp('voice', filePath, '');
                ctx.reply('✅ Voice message sent to WhatsApp');
            }
        });

        // Stickers - سب کے لیے کھلا
        telegramBot.on('sticker', async (ctx) => {
            const sticker = ctx.message.sticker;
            ctx.reply('📥 Downloading sticker...');
            const fileExt = sticker.is_animated ? 'tgs' : 'webp';
            const filePath = await downloadTelegramFile(sticker.file_id, fileExt);
            if (filePath) {
                const session = sessions.get(config.sessionId || 'wasi_session');
                if (session && session.sock && session.isConnected) {
                    for (const targetJid of telegramTargetJids) {
                        await session.sock.sendMessage(targetJid, { 
                            sticker: { url: filePath } 
                        });
                    }
                    ctx.reply('✅ Sticker sent to WhatsApp');
                }
                fs.unlink(filePath, () => {});
            }
        });

        // Error handling
        telegramBot.catch((err, ctx) => {
            console.error('Telegram bot error:', err);
            ctx.reply('❌ An error occurred').catch(() => {});
        });

        // Launch bot
        await telegramBot.launch();
        console.log('🤖 Telegram bot started - PUBLIC ACCESS');
        console.log(`🎯 WhatsApp targets: ${telegramTargetJids.length ? telegramTargetJids.join(', ') : 'None'}`);

        process.once('SIGINT', () => telegramBot.stop('SIGINT'));
        process.once('SIGTERM', () => telegramBot.stop('SIGTERM'));

    } catch (error) {
        console.error('Failed to start Telegram bot:', error);
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
            publicAccess: true,
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
        console.log(`\n🤖 Telegram Bot: ${telegramEnabled ? '✅ ENABLED - PUBLIC ACCESS' : '❌ DISABLED'}`);
        console.log(`🤖 WhatsApp Commands: !ping, !jid, !gjid`);
        console.log(`\n✨ No warnings - Clean boot!`);
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
