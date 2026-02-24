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
const { Telegraf } = require('telegraf');
const axios = require('axios');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const crypto = require('crypto');

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
// CONFIGURATION
// -----------------------------------------------------------------------------
const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',').map(j => j.trim()).filter(j => j)
    : [];

// Create temp directory for files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean old temp files
setInterval(() => {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            console.log(`🧹 Cleaned old temp file: ${file}`);
        }
    });
}, 30 * 60 * 1000);

// -----------------------------------------------------------------------------
// TELEGRAM BOT SETUP
// -----------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

let telegramBot = null;
let telegramEnabled = false;
let whatsappSock = null;

// Initialize Telegram Bot if token exists
if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
    try {
        telegramBot = new Telegraf(TELEGRAM_TOKEN);
        telegramEnabled = true;
        console.log('✅ Telegram Bot initialized');
        
        telegramBot.launch().then(() => {
            console.log('🤖 Telegram Bot is running');
        }).catch(err => {
            console.error('Telegram bot launch error:', err);
            telegramEnabled = false;
        });
        
        // Handle all messages from Telegram
        telegramBot.on('message', async (ctx) => {
            try {
                if (!whatsappSock || !whatsappSock.user) {
                    await ctx.reply('❌ WhatsApp is not connected. Please scan QR code first.');
                    return;
                }

                if (TARGET_JIDS.length === 0) {
                    await ctx.reply('❌ No target JIDs configured.');
                    return;
                }

                const replyMsg = await ctx.reply('🔄 Forwarding to WhatsApp...');

                // TEXT
                if (ctx.message.text) {
                    await forwardText(ctx.message.text);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Forwarded!');
                }
                
                // PHOTO
                else if (ctx.message.photo) {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardPhoto(fileLink.href, caption);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Photo forwarded!');
                }
                
                // VIDEO - FIXED VERSION
                else if (ctx.message.video) {
                    const video = ctx.message.video;
                    const fileLink = await ctx.telegram.getFileLink(video.file_id);
                    const caption = ctx.message.caption || '';
                    const fileSizeMB = (video.file_size / (1024 * 1024)).toFixed(2);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, 
                        `📥 Downloading video (${fileSizeMB} MB)...`);
                    
                    // Simple approach: download then send
                    await forwardVideo(fileLink.href, caption);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Video forwarded!');
                }
                
                // DOCUMENT
                else if (ctx.message.document) {
                    const document = ctx.message.document;
                    const fileLink = await ctx.telegram.getFileLink(document.file_id);
                    const caption = ctx.message.caption || '';
                    const fileName = document.file_name || `document_${Date.now()}`;
                    const fileSizeMB = (document.file_size / (1024 * 1024)).toFixed(2);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, 
                        `📥 Downloading document (${fileSizeMB} MB)...`);
                    
                    await forwardDocument(fileLink.href, fileName, caption);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Document forwarded!');
                }
                
                // AUDIO
                else if (ctx.message.audio) {
                    const audio = ctx.message.audio;
                    const fileLink = await ctx.telegram.getFileLink(audio.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardAudio(fileLink.href, caption);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Audio forwarded!');
                }
                
                // VOICE
                else if (ctx.message.voice) {
                    const voice = ctx.message.voice;
                    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
                    await forwardVoice(fileLink.href);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Voice note forwarded!');
                }
                
                // STICKER
                else if (ctx.message.sticker) {
                    const sticker = ctx.message.sticker;
                    const fileLink = await ctx.telegram.getFileLink(sticker.file_id);
                    await forwardSticker(fileLink.href);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Sticker forwarded!');
                }
                
                else {
                    await ctx.reply('❌ Unsupported message type.');
                }
                
            } catch (error) {
                console.error('Error:', error);
                await ctx.reply(`❌ Error: ${error.message}`);
            }
        });

        // Status command
        telegramBot.command('status', async (ctx) => {
            const status = whatsappSock && whatsappSock.user ? '✅ Connected' : '❌ Disconnected';
            const targets = TARGET_JIDS.length > 0 ? TARGET_JIDS.join('\n') : 'Not configured';
            await ctx.reply(
                `📱 *WhatsApp Status:* ${status}\n\n` +
                `🎯 *Target JIDs:*\n${targets}`
            );
        });
        
    } catch (error) {
        console.error('Telegram bot initialization error:', error);
        telegramEnabled = false;
    }
}

// -----------------------------------------------------------------------------
// SIMPLE FORWARDING FUNCTIONS - 100% WORKING
// -----------------------------------------------------------------------------

/**
 * Forward text
 */
async function forwardText(text) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    for (const jid of TARGET_JIDS) {
        try {
            await whatsappSock.sendMessage(jid, { text: text });
            console.log(`✅ Text to ${jid}`);
        } catch (err) {
            console.error(`Failed to ${jid}:`, err.message);
        }
    }
}

/**
 * Forward photo - download first (works 100%)
 */
async function forwardPhoto(url, caption) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        // Download full image
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            maxContentLength: 100 * 1024 * 1024 // 100MB limit
        });
        
        const buffer = Buffer.from(response.data);
        
        for (const jid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(jid, { 
                    image: buffer,
                    caption: caption
                });
                console.log(`✅ Photo to ${jid}`);
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Photo error:', error);
        throw error;
    }
}

/**
 * Forward video - download first (works 100%)
 */
async function forwardVideo(url, caption) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    const tempPath = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
    
    try {
        // Download to temp file
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            maxContentLength: 500 * 1024 * 1024 // 500MB limit
        });
        
        const writer = fs.createWriteStream(tempPath);
        await pipeline(response.data, writer);
        
        // Read from temp file
        const videoBuffer = fs.readFileSync(tempPath);
        const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);
        console.log(`📊 Video size: ${fileSizeMB} MB`);
        
        for (const jid of TARGET_JIDS) {
            try {
                // اگر 50MB سے کم ہو تو video کے طور پر بھیجو
                if (videoBuffer.length <= 64 * 1024 * 1024) {
                    await whatsappSock.sendMessage(jid, {
                        video: videoBuffer,
                        caption: caption,
                        mimetype: 'video/mp4'
                    });
                    console.log(`✅ Video (media) to ${jid}`);
                } 
                // 50MB سے زیادہ ہو تو document کے طور پر
                else {
                    await whatsappSock.sendMessage(jid, {
                        document: videoBuffer,
                        fileName: `video_${Date.now()}.mp4`,
                        caption: caption,
                        mimetype: 'video/mp4'
                    });
                    console.log(`✅ Video (document) to ${jid}`);
                }
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
        
    } catch (error) {
        console.error('Video error:', error);
        throw error;
    } finally {
        // Clean up
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
}

/**
 * Forward document
 */
async function forwardDocument(url, fileName, caption) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    const tempPath = path.join(TEMP_DIR, `doc_${Date.now()}_${fileName}`);
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            maxContentLength: 2 * 1024 * 1024 * 1024 // 2GB limit
        });
        
        const writer = fs.createWriteStream(tempPath);
        await pipeline(response.data, writer);
        
        const fileBuffer = fs.readFileSync(tempPath);
        const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
        console.log(`📊 Document size: ${fileSizeMB} MB`);
        
        for (const jid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(jid, {
                    document: fileBuffer,
                    fileName: fileName,
                    caption: caption,
                    mimetype: 'application/octet-stream'
                });
                console.log(`✅ Document to ${jid}`);
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
        
    } catch (error) {
        console.error('Document error:', error);
        throw error;
    } finally {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
}

/**
 * Forward audio
 */
async function forwardAudio(url, caption) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });
        
        const buffer = Buffer.from(response.data);
        
        for (const jid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(jid, { 
                    audio: buffer,
                    mimetype: 'audio/mpeg',
                    caption: caption
                });
                console.log(`✅ Audio to ${jid}`);
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Audio error:', error);
    }
}

/**
 * Forward voice note
 */
async function forwardVoice(url) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });
        
        const buffer = Buffer.from(response.data);
        
        for (const jid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(jid, { 
                    audio: buffer,
                    mimetype: 'audio/mp4',
                    ptt: true
                });
                console.log(`✅ Voice to ${jid}`);
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Voice error:', error);
    }
}

/**
 * Forward sticker
 */
async function forwardSticker(url) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });
        
        const buffer = Buffer.from(response.data);
        
        for (const jid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(jid, { 
                    sticker: buffer
                });
                console.log(`✅ Sticker to ${jid}`);
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Sticker error:', error);
    }
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
// COMMAND HANDLER
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
            response += `${groupCount}. *${group.subject}*\n`;
            response += `   🆔: \`${jid}\`\n\n`;
            groupCount++;
        }
        
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error('Error:', error);
        await sock.sendMessage(from, { text: "❌ Error fetching groups." });
    }
}

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    let text = msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               "";
    
    if (!text.startsWith('!')) return;
    
    const cmd = text.trim().toLowerCase();
    
    if (cmd === '!ping') await handlePingCommand(sock, from);
    else if (cmd === '!jid') await handleJidCommand(sock, from);
    else if (cmd === '!gjid') await handleGjidCommand(sock, from);
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) return;
        if (existing.sock) {
            existing.sock.ev.removeAllListeners();
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting: ${sessionId}`);

    const sessionState = { sock: null, isConnected: false, qr: null };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;
    whatsappSock = wasi_sock;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            console.log(`QR for ${sessionId}`);
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
                whatsappSock = null;
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId} Connected`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    wasi_sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (msg.message) await processCommand(wasi_sock, msg);
    });
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);
    
    let qrDataUrl = null;
    if (session?.qr) {
        qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 }).catch(() => null);
    }

    res.json({
        sessionId,
        connected: session?.isConnected || false,
        qr: qrDataUrl,
        telegramEnabled,
        targets: TARGET_JIDS
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
function startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server on port ${wasi_port}`);
        console.log(`🤖 Commands: !ping, !jid, !gjid`);
        if (telegramEnabled) {
            console.log(`📱 Telegram Bot: Active`);
            console.log(`🎯 Targets: ${TARGET_JIDS.length}`);
        }
    });
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
        console.log('✅ Database connected');
    }

    await startSession(config.sessionId || 'wasi_session');
    startServer();
}

main();

// Clean shutdown
process.once('SIGINT', () => {
    if (telegramBot) telegramBot?.stop('SIGINT');
    // Clean temp
    if (fs.existsSync(TEMP_DIR)) {
        fs.readdirSync(TEMP_DIR).forEach(f => fs.unlinkSync(path.join(TEMP_DIR, f)));
    }
    process.exit(0);
});
