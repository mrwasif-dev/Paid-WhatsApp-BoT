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
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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

// Create temp directory
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

                const replyMsg = await ctx.reply('🔄 Processing...');

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
                
                // VIDEO - FIXED WITH FAST START
                else if (ctx.message.video) {
                    const video = ctx.message.video;
                    const fileLink = await ctx.telegram.getFileLink(video.file_id);
                    const caption = ctx.message.caption || '';
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '📥 Downloading video...');
                    
                    // Download, optimize for streaming, and send
                    await forwardVideoOptimized(fileLink.href, caption);
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Video optimized for streaming!');
                }
                
                // DOCUMENT
                else if (ctx.message.document) {
                    const doc = ctx.message.document;
                    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
                    const caption = ctx.message.caption || '';
                    const fileName = doc.file_name || `file_${Date.now()}`;
                    await forwardDocument(fileLink.href, fileName, caption);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Document forwarded!');
                }
                
                // AUDIO
                else if (ctx.message.audio || ctx.message.voice) {
                    const media = ctx.message.audio || ctx.message.voice;
                    const fileLink = await ctx.telegram.getFileLink(media.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardAudio(fileLink.href, caption, !!ctx.message.voice);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Audio forwarded!');
                }
                
                // STICKER
                else if (ctx.message.sticker) {
                    const sticker = ctx.message.sticker;
                    const fileLink = await ctx.telegram.getFileLink(sticker.file_id);
                    await forwardSticker(fileLink.href);
                    await ctx.telegram.editMessageText(ctx.chat.id, replyMsg.message_id, null, '✅ Sticker forwarded!');
                }
                
            } catch (error) {
                console.error('Error:', error);
                await ctx.reply(`❌ Error: ${error.message}`);
            }
        });

        // Status command
        telegramBot.command('status', async (ctx) => {
            const status = whatsappSock?.user ? '✅ Connected' : '❌ Disconnected';
            const targets = TARGET_JIDS.join('\n') || 'None';
            await ctx.reply(
                `📱 *WhatsApp Status:* ${status}\n\n` +
                `🎯 *Targets:*\n${targets}`
            );
        });
        
    } catch (error) {
        console.error('Telegram init error:', error);
    }
}

// -----------------------------------------------------------------------------
// FORWARDING FUNCTIONS
// -----------------------------------------------------------------------------

async function forwardText(text) {
    for (const jid of TARGET_JIDS) {
        try {
            await whatsappSock.sendMessage(jid, { text });
            console.log(`✅ Text to ${jid}`);
        } catch (err) {
            console.error(`Failed to ${jid}:`, err.message);
        }
    }
}

async function forwardPhoto(url, caption) {
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
 * Optimize video for streaming (moov atom at start)
 * یہ ویڈیو کو فوراً چلنے کے قابل بنائے گا
 */
async function optimizeVideoForStreaming(inputPath, outputPath) {
    try {
        // Use ffmpeg to move moov atom to beginning (faststart)
        const cmd = `ffmpeg -i "${inputPath}" -c copy -movflags +faststart "${outputPath}" -y`;
        await execPromise(cmd);
        console.log('✅ Video optimized for streaming');
        return true;
    } catch (error) {
        console.error('Video optimization error:', error);
        return false;
    }
}

/**
 * Extract thumbnail from video
 */
async function extractThumbnail(videoPath) {
    const thumbPath = path.join(TEMP_DIR, `thumb_${Date.now()}.jpg`);
    
    try {
        const cmd = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:240" "${thumbPath}" -y`;
        await execPromise(cmd);
        
        if (fs.existsSync(thumbPath)) {
            const thumb = fs.readFileSync(thumbPath);
            fs.unlinkSync(thumbPath);
            return thumb;
        }
        return null;
    } catch (error) {
        console.error('Thumbnail error:', error);
        return null;
    }
}

/**
 * Forward video with fast start (plays immediately)
 */
async function forwardVideoOptimized(url, caption) {
    const videoPath = path.join(TEMP_DIR, `video_${Date.now()}_original.mp4`);
    const optimizedPath = path.join(TEMP_DIR, `video_${Date.now()}_optimized.mp4`);
    
    try {
        // Download video
        console.log('📥 Downloading video...');
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });
        
        const writer = fs.createWriteStream(videoPath);
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        // Generate thumbnail
        console.log('🖼️ Generating thumbnail...');
        const thumbnail = await extractThumbnail(videoPath);
        
        // Optimize for streaming (moov atom at start)
        console.log('⚡ Optimizing video for instant playback...');
        await optimizeVideoForStreaming(videoPath, optimizedPath);
        
        // Read optimized video
        const videoBuffer = fs.readFileSync(optimizedPath);
        const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);
        console.log(`📊 Video: ${fileSizeMB} MB, Thumbnail: ${thumbnail ? '✅' : '❌'}`);
        
        // Send to WhatsApp
        for (const jid of TARGET_JIDS) {
            try {
                const messageOptions = {
                    video: videoBuffer,
                    caption: caption,
                    mimetype: 'video/mp4'
                };
                
                if (thumbnail) {
                    messageOptions.jpegThumbnail = thumbnail;
                }
                
                // اگر 50MB سے کم ہو تو video
                if (videoBuffer.length <= 50 * 1024 * 1024) {
                    await whatsappSock.sendMessage(jid, messageOptions);
                    console.log(`✅ Video (media) to ${jid} - Instant playback enabled`);
                } 
                // 50MB سے زیادہ ہو تو document
                else {
                    await whatsappSock.sendMessage(jid, {
                        document: videoBuffer,
                        fileName: `video_${Date.now()}.mp4`,
                        caption: caption,
                        mimetype: 'video/mp4',
                        jpegThumbnail: thumbnail
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
        // Cleanup
        [videoPath, optimizedPath].forEach(p => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        });
    }
}

async function forwardDocument(url, fileName, caption) {
    const docPath = path.join(TEMP_DIR, `doc_${Date.now()}_${fileName}`);
    
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });
        
        const writer = fs.createWriteStream(docPath);
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        const fileBuffer = fs.readFileSync(docPath);
        
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
        if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
    }
}

async function forwardAudio(url, caption, isVoice = false) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });
        const buffer = Buffer.from(response.data);
        
        for (const jid of TARGET_JIDS) {
            try {
                if (isVoice) {
                    await whatsappSock.sendMessage(jid, { 
                        audio: buffer,
                        mimetype: 'audio/mp4',
                        ptt: true
                    });
                    console.log(`✅ Voice to ${jid}`);
                } else {
                    await whatsappSock.sendMessage(jid, { 
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        caption: caption
                    });
                    console.log(`✅ Audio to ${jid}`);
                }
            } catch (err) {
                console.error(`Failed to ${jid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Audio error:', error);
    }
}

async function forwardSticker(url) {
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
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
const sessions = new Map();

wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

wasi_app.get('/ping', (req, res) => res.send('pong'));

// WhatsApp commands
async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: from });
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let response = "📌 *Groups List:*\n\n";
        let i = 1;
        for (const [jid, g] of Object.entries(groups)) {
            response += `${i}. *${g.subject}*\n🆔 \`${jid}\`\n\n`;
            i++;
            if (i > 20) break;
        }
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        await sock.sendMessage(from, { text: "❌ Error fetching groups" });
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

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected) return;
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
    
    wasi_sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sessionState.qr = qr;
            console.log(`📱 QR for ${sessionId}`);
        }
        
        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;
            
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                sessions.delete(sessionId);
                wasi_clearSession(sessionId);
                whatsappSock = null;
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId} Connected`);
        }
    });
    
    wasi_sock.ev.on('creds.update', saveCreds);
    wasi_sock.ev.on('messages.upsert', (m) => {
        if (m.messages[0]?.message) processCommand(wasi_sock, m.messages[0]);
    });
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);
    
    let qrDataUrl = null;
    if (session?.qr) {
        qrDataUrl = await QRCode.toDataURL(session.qr).catch(() => null);
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
// START
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
        console.log('✅ Database connected');
    }
    
    await startSession(config.sessionId || 'wasi_session');
    
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server on port ${wasi_port}`);
        console.log(`🤖 Commands: !ping, !jid, !gjid`);
        if (telegramEnabled) {
            console.log(`📱 Telegram Bot: Active`);
            console.log(`🎯 Targets: ${TARGET_JIDS.length}`);
            console.log(`🎬 Video Streaming: Enabled (plays immediately!)`);
            console.log(`🖼️ Thumbnails: Enabled`);
        }
    });
}

main().catch(console.error);

process.once('SIGINT', () => {
    telegramBot?.stop('SIGINT');
    if (fs.existsSync(TEMP_DIR)) {
        fs.readdirSync(TEMP_DIR).forEach(f => fs.unlinkSync(path.join(TEMP_DIR, f)));
    }
    process.exit(0);
});
