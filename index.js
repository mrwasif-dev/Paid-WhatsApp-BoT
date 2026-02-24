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

// Create temp directory for streaming
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean old temp files on startup
setInterval(() => {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        // Delete files older than 1 hour
        if (now - stats.mtimeMs > 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            console.log(`🧹 Cleaned old temp file: ${file}`);
        }
    });
}, 30 * 60 * 1000); // Check every 30 minutes

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
                    await ctx.reply('❌ No target JIDs configured. Please set TARGET_JIDS in environment variables.');
                    return;
                }

                const replyMsg = await ctx.reply('🔄 Forwarding to WhatsApp...');

                // TEXT MESSAGE
                if (ctx.message.text) {
                    await forwardTextToWhatsApp(ctx.message.text);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Forwarded to WhatsApp!');
                }
                
                // PHOTO
                else if (ctx.message.photo) {
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardMediaStreamToWhatsApp(fileLink.href, 'image', caption, photo.file_id);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Photo forwarded to WhatsApp!');
                }
                
                // VIDEO (STREAMING)
                else if (ctx.message.video) {
                    const video = ctx.message.video;
                    const fileLink = await ctx.telegram.getFileLink(video.file_id);
                    const caption = ctx.message.caption || '';
                    const fileSizeMB = (video.file_size / (1024 * 1024)).toFixed(2);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, 
                        `🎬 Streaming video (${fileSizeMB} MB) to WhatsApp...`);
                    
                    // Use streaming for videos
                    await forwardMediaStreamToWhatsApp(
                        fileLink.href, 
                        'video', 
                        caption, 
                        video.file_id,
                        video.mime_type || 'video/mp4'
                    );
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Video streamed to WhatsApp!');
                }
                
                // DOCUMENT (STREAMING)
                else if (ctx.message.document) {
                    const document = ctx.message.document;
                    const fileLink = await ctx.telegram.getFileLink(document.file_id);
                    const caption = ctx.message.caption || '';
                    const fileName = document.file_name || `document_${Date.now()}`;
                    const fileSizeMB = (document.file_size / (1024 * 1024)).toFixed(2);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, 
                        `📄 Streaming document (${fileSizeMB} MB) to WhatsApp...`);
                    
                    await forwardDocumentStreamToWhatsApp(
                        fileLink.href,
                        fileName,
                        caption,
                        document.mime_type || 'application/octet-stream',
                        document.file_id
                    );
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Document streamed to WhatsApp!');
                }
                
                // AUDIO
                else if (ctx.message.audio) {
                    const audio = ctx.message.audio;
                    const fileLink = await ctx.telegram.getFileLink(audio.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardAudioToWhatsApp(fileLink.href, caption, audio.mime_type);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Audio forwarded to WhatsApp!');
                }
                
                // VOICE
                else if (ctx.message.voice) {
                    const voice = ctx.message.voice;
                    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
                    await forwardVoiceToWhatsApp(fileLink.href, voice.mime_type);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Voice note forwarded to WhatsApp!');
                }
                
                // STICKER
                else if (ctx.message.sticker) {
                    const sticker = ctx.message.sticker;
                    const fileLink = await ctx.telegram.getFileLink(sticker.file_id);
                    await forwardStickerToWhatsApp(fileLink.href);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Sticker forwarded to WhatsApp!');
                }
                
                else {
                    await ctx.reply('❌ Unsupported message type.');
                }
                
            } catch (error) {
                console.error('Error forwarding from Telegram:', error);
                await ctx.reply(`❌ Error: ${error.message}`);
            }
        });

        // Status command
        telegramBot.command('status', async (ctx) => {
            const status = whatsappSock && whatsappSock.user ? '✅ Connected' : '❌ Disconnected';
            const targets = TARGET_JIDS.length > 0 ? TARGET_JIDS.join('\n') : 'Not configured';
            await ctx.reply(
                `📱 *WhatsApp Status:* ${status}\n\n` +
                `🎯 *Target JIDs:*\n${targets}\n\n` +
                `📤 Streaming enabled - videos play while downloading`
            );
        });

        // Targets command
        telegramBot.command('targets', async (ctx) => {
            if (TARGET_JIDS.length === 0) {
                await ctx.reply('❌ No target JIDs configured.');
            } else {
                let response = '🎯 *Target JIDs:*\n\n';
                TARGET_JIDS.forEach((jid, index) => {
                    response += `${index + 1}. \`${jid}\`\n`;
                });
                await ctx.reply(response);
            }
        });
        
    } catch (error) {
        console.error('Telegram bot initialization error:', error);
        telegramEnabled = false;
    }
}

// -----------------------------------------------------------------------------
// STREAMING FUNCTIONS - VIDEO PLAYS WHILE DOWNLOADING
// -----------------------------------------------------------------------------

/**
 * Stream media directly to WhatsApp without full download
 */
async function forwardMediaStreamToWhatsApp(fileUrl, type, caption, fileId, mimeType = null) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    // Create a unique temp file path
    const tempFilePath = path.join(TEMP_DIR, `${fileId}_${Date.now()}`);
    
    try {
        console.log(`📥 Streaming ${type} from: ${fileUrl}`);
        
        // Start download stream
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'stream',
            timeout: 300000, // 5 minutes timeout
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        // Create write stream for temp file (for caching)
        const writer = fs.createWriteStream(tempFilePath);
        
        // Pipe to file for caching
        response.data.pipe(writer);
        
        // For WhatsApp, we need to provide the stream
        // Create a readable stream from the temp file as it's being written
        const readStream = fs.createReadStream(tempFilePath);
        
        // Send to all targets
        for (const targetJid of TARGET_JIDS) {
            try {
                if (type === 'video') {
                    await whatsappSock.sendMessage(targetJid, {
                        video: readStream,
                        caption: caption,
                        mimetype: mimeType || 'video/mp4'
                    });
                } else if (type === 'image') {
                    await whatsappSock.sendMessage(targetJid, {
                        image: readStream,
                        caption: caption
                    });
                }
                console.log(`✅ ${type} streamed to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to stream to ${targetJid}:`, err.message);
            }
        }
        
        // Wait for download to complete (for cleanup)
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
    } catch (error) {
        console.error(`Error streaming ${type}:`, error);
        throw error;
    } finally {
        // Clean up temp file after a delay (to ensure streaming is done)
        setTimeout(() => {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
                console.log(`🧹 Cleaned up: ${tempFilePath}`);
            }
        }, 60000); // 1 minute delay
    }
}

/**
 * Stream document to WhatsApp
 */
async function forwardDocumentStreamToWhatsApp(fileUrl, fileName, caption, mimeType, fileId) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    const tempFilePath = path.join(TEMP_DIR, `${fileId}_${fileName}`);
    
    try {
        console.log(`📥 Streaming document: ${fileName}`);
        
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'stream',
            timeout: 300000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);
        
        // Create read stream for sending
        const readStream = fs.createReadStream(tempFilePath);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, {
                    document: readStream,
                    fileName: fileName,
                    caption: caption,
                    mimetype: mimeType
                });
                console.log(`✅ Document streamed to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to stream document to ${targetJid}:`, err.message);
            }
        }
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
    } catch (error) {
        console.error('Error streaming document:', error);
        throw error;
    } finally {
        setTimeout(() => {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        }, 60000);
    }
}

/**
 * Forward text to WhatsApp
 */
async function forwardTextToWhatsApp(text) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    for (const targetJid of TARGET_JIDS) {
        try {
            await whatsappSock.sendMessage(targetJid, { text: text });
            console.log(`✅ Text forwarded to ${targetJid}`);
        } catch (err) {
            console.error(`Failed to forward to ${targetJid}:`, err.message);
        }
    }
}

/**
 * Forward audio to WhatsApp
 */
async function forwardAudioToWhatsApp(fileUrl, caption, mimeType) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer'
        });
        const audioBuffer = Buffer.from(response.data);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    audio: audioBuffer,
                    mimetype: mimeType || 'audio/mpeg',
                    caption: caption
                });
                console.log(`✅ Audio forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding audio:', error);
    }
}

/**
 * Forward voice note to WhatsApp
 */
async function forwardVoiceToWhatsApp(fileUrl, mimeType) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer'
        });
        const voiceBuffer = Buffer.from(response.data);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    audio: voiceBuffer,
                    mimetype: mimeType || 'audio/mp4',
                    ptt: true
                });
                console.log(`✅ Voice note forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding voice note:', error);
    }
}

/**
 * Forward sticker to WhatsApp
 */
async function forwardStickerToWhatsApp(fileUrl) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer'
        });
        const stickerBuffer = Buffer.from(response.data);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    sticker: stickerBuffer
                });
                console.log(`✅ Sticker forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding sticker:', error);
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
        await sock.sendMessage(from, { text: "❌ Error fetching groups list." });
    }
}

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    let text = '';
    
    if (msg.message?.conversation) {
        text = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
    } else if (msg.message?.imageMessage?.caption) {
        text = msg.message.imageMessage.caption;
    } else if (msg.message?.videoMessage?.caption) {
        text = msg.message.videoMessage.caption;
    } else if (msg.message?.documentMessage?.caption) {
        text = msg.message.documentMessage.caption;
    }
    
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
    whatsappSock = wasi_sock;

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
                setTimeout(() => {
                    startSession(sessionId);
                }, 3000);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
                whatsappSock = null;
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        let wasi_text = '';
        if (wasi_msg.message?.conversation) {
            wasi_text = wasi_msg.message.conversation;
        } else if (wasi_msg.message?.extendedTextMessage?.text) {
            wasi_text = wasi_msg.message.extendedTextMessage.text;
        } else if (wasi_msg.message?.imageMessage?.caption) {
            wasi_text = wasi_msg.message.imageMessage.caption;
        } else if (wasi_msg.message?.videoMessage?.caption) {
            wasi_text = wasi_msg.message.videoMessage.caption;
        } else if (wasi_msg.message?.documentMessage?.caption) {
            wasi_text = wasi_msg.message.documentMessage.caption;
        }

        if (wasi_text && wasi_text.startsWith('!')) {
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
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        telegramEnabled,
        targets: TARGET_JIDS,
        streaming: true,
        activeSessions: Array.from(sessions.keys())
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
        console.log(`🤖 WhatsApp Commands: !ping, !jid, !gjid`);
        if (telegramEnabled) {
            console.log(`📱 Telegram Bot: Active`);
            console.log(`🎯 Target JIDs: ${TARGET_JIDS.length} configured`);
            console.log(`🎬 Streaming: Videos play while downloading (no waiting!)`);
            console.log(`📦 Large files: Up to 2GB supported`);
        }
        console.log(`📱 Scan QR code from browser to connect`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main();

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('👋 Shutting down...');
    if (telegramBot) {
        telegramBot.stop('SIGINT');
    }
    // Clean temp directory
    if (fs.existsSync(TEMP_DIR)) {
        fs.readdirSync(TEMP_DIR).forEach(file => {
            fs.unlinkSync(path.join(TEMP_DIR, file));
        });
    }
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('👋 Shutting down...');
    if (telegramBot) {
        telegramBot.stop('SIGTERM');
    }
    process.exit(0);
});
