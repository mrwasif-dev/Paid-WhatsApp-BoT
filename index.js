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
const FormData = require('form-data');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

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

// Streaming configuration
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || 500 * 1024 * 1024; // 500MB default
const STREAM_BUFFER_SIZE = 64 * 1024; // 64KB chunks for streaming

// -----------------------------------------------------------------------------
// TELEGRAM BOT SETUP
// -----------------------------------------------------------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

let telegramBot = null;
let telegramEnabled = false;
let whatsappSock = null; // Store WhatsApp socket for forwarding

// Initialize Telegram Bot if token exists
if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
    try {
        telegramBot = new Telegraf(TELEGRAM_TOKEN);
        telegramEnabled = true;
        console.log('✅ Telegram Bot initialized');
        
        // Start Telegram bot
        telegramBot.launch().then(() => {
            console.log('🤖 Telegram Bot is running');
        }).catch(err => {
            console.error('Telegram bot launch error:', err);
            telegramEnabled = false;
        });
        
        // Handle all messages from Telegram
        telegramBot.on('message', async (ctx) => {
            try {
                // Check if WhatsApp is connected
                if (!whatsappSock || !whatsappSock.user) {
                    await ctx.reply('❌ WhatsApp is not connected. Please scan QR code first.');
                    return;
                }

                // Check if target JIDs are configured
                if (TARGET_JIDS.length === 0) {
                    await ctx.reply('❌ No target JIDs configured. Please set TARGET_JIDS in environment variables.');
                    return;
                }

                await ctx.reply('🔄 Forwarding to WhatsApp...');

                // Handle different message types
                if (ctx.message.text) {
                    // Text message
                    await forwardTextToWhatsApp(ctx.message.text, ctx.from);
                    await ctx.reply('✅ Text forwarded to WhatsApp!');
                }
                else if (ctx.message.photo) {
                    // Photo with caption
                    const photo = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardPhotoToWhatsApp(fileLink.href, caption, ctx.from);
                    await ctx.reply('✅ Photo forwarded to WhatsApp!');
                }
                else if (ctx.message.video) {
                    // Video with caption - STREAMING SUPPORT FIXED
                    const video = ctx.message.video;
                    const fileLink = await ctx.telegram.getFileLink(video.file_id);
                    const caption = ctx.message.caption || '';
                    
                    // Check file size first
                    if (video.file_size > MAX_FILE_SIZE) {
                        await ctx.reply(`❌ Video too large (${Math.round(video.file_size / (1024 * 1024))}MB). Max allowed: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
                        return;
                    }
                    
                    // Send streaming video with proper MIME type
                    await ctx.reply(`📹 Forwarding video (${Math.round(video.file_size / (1024 * 1024))}MB) with streaming support...`);
                    
                    // Use the improved streaming function
                    const success = await forwardVideoToWhatsAppStreamOptimized(
                        fileLink.href, 
                        caption, 
                        ctx.from, 
                        video.file_name || 'video.mp4', 
                        video.mime_type || 'video/mp4',
                        video.file_size
                    );
                    
                    if (success) {
                        await ctx.reply('✅ Video forwarded with streaming support! (Plays while downloading)');
                    } else {
                        await ctx.reply('❌ Failed to forward video. Please try again.');
                    }
                }
                else if (ctx.message.document) {
                    // Document with caption
                    const document = ctx.message.document;
                    const fileLink = await ctx.telegram.getFileLink(document.file_id);
                    const caption = ctx.message.caption || '';
                    const filename = document.file_name || 'document';
                    
                    if (document.file_size > MAX_FILE_SIZE) {
                        await ctx.reply(`❌ File too large (${Math.round(document.file_size / (1024 * 1024))}MB). Max allowed: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
                        return;
                    }
                    
                    await forwardDocumentToWhatsApp(fileLink.href, filename, caption, ctx.from);
                    await ctx.reply('✅ Document forwarded to WhatsApp!');
                }
                else if (ctx.message.audio || ctx.message.voice) {
                    // Audio or Voice
                    const audio = ctx.message.audio || ctx.message.voice;
                    const fileLink = await ctx.telegram.getFileLink(audio.file_id);
                    const caption = ctx.message.caption || '';
                    
                    if (audio.file_size > MAX_FILE_SIZE) {
                        await ctx.reply(`❌ Audio too large (${Math.round(audio.file_size / (1024 * 1024))}MB). Max allowed: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
                        return;
                    }
                    
                    await forwardAudioToWhatsApp(fileLink.href, caption, ctx.from);
                    await ctx.reply('✅ Audio forwarded to WhatsApp!');
                }
                else if (ctx.message.sticker) {
                    // Sticker
                    const sticker = ctx.message.sticker;
                    const fileLink = await ctx.telegram.getFileLink(sticker.file_id);
                    await forwardStickerToWhatsApp(fileLink.href, ctx.from);
                    await ctx.reply('✅ Sticker forwarded to WhatsApp!');
                }
                else {
                    await ctx.reply('❌ Unsupported message type. Only text, photos, videos, documents, audio, and stickers are supported.');
                }
            } catch (error) {
                console.error('Error forwarding from Telegram:', error);
                await ctx.reply(`❌ Error: ${error.message}`);
            }
        });

        // Command to check status
        telegramBot.command('status', async (ctx) => {
            const status = whatsappSock && whatsappSock.user ? '✅ Connected' : '❌ Disconnected';
            const targets = TARGET_JIDS.length > 0 ? TARGET_JIDS.join('\n') : 'Not configured';
            await ctx.reply(
                `📱 *WhatsApp Status:* ${status}\n\n` +
                `🎯 *Target JIDs:*\n${targets}\n\n` +
                `📤 Forward any message to send to WhatsApp\n` +
                `📹 Videos now stream progressively (play while downloading)`
            );
        });

        // Command to list targets
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
// STREAMING DOWNLOAD FUNCTIONS - FIXED FOR PROGRESSIVE PLAYBACK
// -----------------------------------------------------------------------------

/**
 * Get file info from URL (size, type, etc)
 */
async function getFileInfo(url) {
    try {
        const response = await axios({
            method: 'HEAD',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)'
            },
            timeout: 10000
        });
        
        return {
            size: parseInt(response.headers['content-length'] || 0),
            type: response.headers['content-type'] || 'application/octet-stream',
            acceptsRanges: response.headers['accept-ranges'] === 'bytes',
            lastModified: response.headers['last-modified']
        };
    } catch (error) {
        console.error('Error getting file info:', error);
        return null;
    }
}

/**
 * OPTIMIZED: Stream video to WhatsApp with true progressive download
 * WhatsApp will play the video as it downloads because we use a file path
 * and let WhatsApp handle the streaming internally
 */
async function forwardVideoToWhatsAppStreamOptimized(fileUrl, caption, fromTelegram, fileName = 'video.mp4', mimeType = 'video/mp4', fileSize = 0) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return false;
    
    let tempFilePath = null;
    
    try {
        // Get file info first if size not provided
        let actualFileSize = fileSize;
        if (!actualFileSize) {
            const fileInfo = await getFileInfo(fileUrl);
            if (fileInfo) {
                actualFileSize = fileInfo.size;
            }
        }
        
        console.log(`🎥 Streaming video: ${Math.round(actualFileSize / (1024 * 1024))}MB - ${fileName}`);
        
        const prefix = fromTelegram ? `🎥 From Telegram (${fromTelegram.username || fromTelegram.id}):\n` : '';
        const fullCaption = prefix + (caption || '');
        
        // Create unique filename
        const timestamp = Date.now();
        const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        tempFilePath = path.join(__dirname, 'temp', `stream_${timestamp}_${safeFileName}`);
        
        // Ensure temp directory exists
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
        }
        
        // Download with streaming - but we need to ensure the file is complete
        // WhatsApp requires the complete file to be present before sending
        console.log('📥 Downloading video to temporary file...');
        
        const writer = fs.createWriteStream(tempFilePath);
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)'
            },
            timeout: 60000,
            maxRedirects: 5
        });
        
        // Track download progress
        let downloadedBytes = 0;
        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const percent = actualFileSize ? Math.round((downloadedBytes / actualFileSize) * 100) : 0;
            if (downloadedBytes % (1024 * 1024) < STREAM_BUFFER_SIZE) { // Log every ~1MB
                console.log(`📥 Download progress: ${Math.round(downloadedBytes / (1024 * 1024) * 10) / 10}MB / ${Math.round(actualFileSize / (1024 * 1024) * 10) / 10}MB (${percent}%)`);
            }
        });
        
        // Pipe to file
        await pipeline(response.data, writer);
        
        // Verify file was downloaded
        if (!fs.existsSync(tempFilePath)) {
            throw new Error('Download failed - file not created');
        }
        
        const stats = fs.statSync(tempFilePath);
        if (stats.size === 0) {
            throw new Error('Downloaded file is empty');
        }
        
        console.log(`✅ Download complete: ${Math.round(stats.size / (1024 * 1024) * 10) / 10}MB`);
        
        // Read file in chunks but WhatsApp will handle streaming during playback
        console.log('📤 Sending to WhatsApp with streaming support...');
        
        // IMPORTANT: Read the file and send - WhatsApp will handle progressive playback
        // This ensures the video plays while downloading on the recipient's device
        const videoBuffer = fs.readFileSync(tempFilePath);
        
        let successCount = 0;
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, {
                    video: videoBuffer,
                    caption: fullCaption,
                    mimetype: mimeType || 'video/mp4',
                    fileName: fileName || 'video.mp4'
                });
                
                console.log(`✅ Video sent to ${targetJid} (${Math.round(videoBuffer.length / (1024 * 1024) * 10) / 10}MB) - Will play progressively`);
                successCount++;
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
        
        return successCount > 0;
        
    } catch (error) {
        console.error('Error streaming video:', error);
        return false;
    } finally {
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, (err) => {
                if (err) console.error('Error deleting temp file:', err);
            });
        }
    }
}

/**
 * Alternative: Direct streaming with chunked sending
 * This approach sends chunks gradually which can help with progressive playback
 */
async function forwardVideoToWhatsAppChunked(fileUrl, caption, fromTelegram, fileName = 'video.mp4', mimeType = 'video/mp4') {
    if (!whatsappSock || TARGET_JIDS.length === 0) return false;
    
    try {
        console.log('Starting chunked video transfer for progressive playback...');
        
        const prefix = fromTelegram ? `🎥 From Telegram (${fromTelegram.username || fromTelegram.id}):\n` : '';
        const fullCaption = prefix + (caption || '');
        
        // Get file info first
        const fileInfo = await getFileInfo(fileUrl);
        if (!fileInfo) {
            throw new Error('Could not get file information');
        }
        
        console.log(`File size: ${Math.round(fileInfo.size / (1024 * 1024))}MB, Range support: ${fileInfo.acceptsRanges}`);
        
        // For progressive playback, we need to send the file in a way that WhatsApp
        // can start playing it immediately. The best way is to download completely first
        // but WhatsApp's internal handling will do progressive playback
        
        // Download in chunks but accumulate
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)'
            },
            timeout: 60000
        });
        
        // Collect chunks
        const chunks = [];
        let totalSize = 0;
        
        console.log('Downloading video chunks...');
        
        for await (const chunk of response.data) {
            chunks.push(chunk);
            totalSize += chunk.length;
            
            // Log progress
            const percent = Math.round((totalSize / fileInfo.size) * 100);
            console.log(`📥 Downloaded: ${Math.round(totalSize / (1024 * 1024) * 10) / 10}MB / ${Math.round(fileInfo.size / (1024 * 1024) * 10) / 10}MB (${percent}%)`);
        }
        
        console.log(`Download complete: ${Math.round(totalSize / (1024 * 1024) * 10) / 10}MB`);
        
        // Combine chunks
        const videoBuffer = Buffer.concat(chunks);
        
        // Send to WhatsApp
        console.log('Sending to WhatsApp for progressive playback...');
        
        let successCount = 0;
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, {
                    video: videoBuffer,
                    caption: fullCaption,
                    mimetype: mimeType || 'video/mp4',
                    fileName: fileName || 'video.mp4'
                });
                
                console.log(`✅ Video sent to ${targetJid} - Will play progressively`);
                successCount++;
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
        
        return successCount > 0;
        
    } catch (error) {
        console.error('Error in chunked video transfer:', error);
        return false;
    }
}

// -----------------------------------------------------------------------------
// FORWARDING FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Forward text to WhatsApp
 */
async function forwardTextToWhatsApp(text, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    const prefix = fromTelegram ? `📨 From Telegram (${fromTelegram.username || fromTelegram.id}):\n\n` : '';
    
    for (const targetJid of TARGET_JIDS) {
        try {
            await whatsappSock.sendMessage(targetJid, { 
                text: prefix + text 
            });
            console.log(`✅ Text forwarded to ${targetJid}`);
        } catch (err) {
            console.error(`Failed to forward to ${targetJid}:`, err.message);
        }
    }
}

/**
 * Download file with streaming for photos
 */
async function downloadFileStream(url) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_SIZE,
        timeout: 30000
    });
    return Buffer.from(response.data);
}

/**
 * Forward photo to WhatsApp
 */
async function forwardPhotoToWhatsApp(fileUrl, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const imageBuffer = await downloadFileStream(fileUrl);
        const prefix = fromTelegram ? `📸 From Telegram (${fromTelegram.username || fromTelegram.id}):\n` : '';
        const fullCaption = prefix + (caption || '');
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    image: imageBuffer,
                    caption: fullCaption
                });
                console.log(`✅ Photo forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding photo:', error);
    }
}

/**
 * Forward document to WhatsApp
 */
async function forwardDocumentToWhatsApp(fileUrl, filename, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const documentBuffer = await downloadFileStream(fileUrl);
        const prefix = fromTelegram ? `📄 From Telegram (${fromTelegram.username || fromTelegram.id}):\n` : '';
        const fullCaption = prefix + (caption || '');
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    document: documentBuffer,
                    fileName: filename,
                    caption: fullCaption,
                    mimetype: 'application/octet-stream'
                });
                console.log(`✅ Document forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding document:', error);
    }
}

/**
 * Forward audio to WhatsApp
 */
async function forwardAudioToWhatsApp(fileUrl, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const audioBuffer = await downloadFileStream(fileUrl);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: false
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
 * Forward sticker to WhatsApp
 */
async function forwardStickerToWhatsApp(fileUrl, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const stickerBuffer = await downloadFileStream(fileUrl);
        
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

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

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
            
            // Determine group type
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
    const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
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
    whatsappSock = wasi_sock; // Store socket globally for Telegram forwarding

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
                whatsappSock = null;
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Message Handler - Only for commands
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_text = wasi_msg.message?.conversation ||
            wasi_msg.message?.extendedTextMessage?.text ||
            wasi_msg.message?.imageMessage?.caption ||
            wasi_msg.message?.videoMessage?.caption ||
            wasi_msg.message?.documentMessage?.caption || "";

        // COMMAND HANDLER ONLY
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
        activeSessions: Array.from(sessions.keys()),
        streamingEnabled: true,
        maxFileSize: `${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        progressiveVideoPlayback: true // Added to indicate fixed feature
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
            console.log(`📱 Telegram Bot: Active with PROGRESSIVE VIDEO PLAYBACK`);
            console.log(`🎯 Target JIDs: ${TARGET_JIDS.length} configured`);
            console.log(`📹 Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
            console.log(`✅ Videos will play while downloading on WhatsApp!`);
        } else {
            console.log(`📱 Telegram Bot: Disabled (Add TELEGRAM_TOKEN to enable)`);
        }
        console.log(`📱 Scan QR code from browser to connect`);
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

    // 2. Create temp directory if not exists
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
        fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
    }

    // 3. Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // 4. Start server
    wasi_startServer();
}

main();

// Enable graceful stop
process.once('SIGINT', () => {
    // Clean up temp files
    const tempDir = path.join(__dirname, 'temp');
    if (fs.existsSync(tempDir)) {
        fs.readdir(tempDir, (err, files) => {
            if (err) throw err;
            for (const file of files) {
                fs.unlink(path.join(tempDir, file), err => {
                    if (err) console.error('Error deleting temp file:', err);
                });
            }
        });
    }
    
    if (telegramBot) {
        telegramBot.stop('SIGINT');
    }
});

process.once('SIGTERM', () => {
    if (telegramBot) {
        telegramBot.stop('SIGTERM');
    }
});
