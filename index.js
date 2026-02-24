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
                    // Video with caption
                    const video = ctx.message.video;
                    const fileLink = await ctx.telegram.getFileLink(video.file_id);
                    const caption = ctx.message.caption || '';
                    await forwardVideoToWhatsApp(fileLink.href, caption, ctx.from);
                    await ctx.reply('✅ Video forwarded to WhatsApp!');
                }
                else if (ctx.message.document) {
                    // Document with caption
                    const document = ctx.message.document;
                    const fileLink = await ctx.telegram.getFileLink(document.file_id);
                    const caption = ctx.message.caption || '';
                    const filename = document.file_name || 'document';
                    await forwardDocumentToWhatsApp(fileLink.href, filename, caption, ctx.from);
                    await ctx.reply('✅ Document forwarded to WhatsApp!');
                }
                else if (ctx.message.audio || ctx.message.voice) {
                    // Audio or Voice
                    const audio = ctx.message.audio || ctx.message.voice;
                    const fileLink = await ctx.telegram.getFileLink(audio.file_id);
                    const caption = ctx.message.caption || '';
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
                `📤 Forward any message to send to WhatsApp`
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
 * Download file from URL and send as buffer
 */
async function downloadFile(url) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
}

/**
 * Forward photo to WhatsApp
 */
async function forwardPhotoToWhatsApp(fileUrl, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const imageBuffer = await downloadFile(fileUrl);
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
 * Forward video to WhatsApp
 */
async function forwardVideoToWhatsApp(fileUrl, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const videoBuffer = await downloadFile(fileUrl);
        const prefix = fromTelegram ? `🎥 From Telegram (${fromTelegram.username || fromTelegram.id}):\n` : '';
        const fullCaption = prefix + (caption || '');
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    video: videoBuffer,
                    caption: fullCaption
                });
                console.log(`✅ Video forwarded to ${targetJid}`);
            } catch (err) {
                console.error(`Failed to forward to ${targetJid}:`, err.message);
            }
        }
    } catch (error) {
        console.error('Error forwarding video:', error);
    }
}

/**
 * Forward document to WhatsApp
 */
async function forwardDocumentToWhatsApp(fileUrl, filename, caption, fromTelegram) {
    if (!whatsappSock || TARGET_JIDS.length === 0) return;
    
    try {
        const documentBuffer = await downloadFile(fileUrl);
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
        const audioBuffer = await downloadFile(fileUrl);
        
        for (const targetJid of TARGET_JIDS) {
            try {
                await whatsappSock.sendMessage(targetJid, { 
                    audio: audioBuffer,
                    mimetype: 'audio/mp4',
                    ptt: false // Set to true for voice note
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
        const stickerBuffer = await downloadFile(fileUrl);
        
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

    // 2. Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // 3. Start server
    wasi_startServer();
}

main();

// Enable graceful stop
process.once('SIGINT', () => {
    if (telegramBot) {
        telegramBot.stop('SIGINT');
    }
});
process.once('SIGTERM', () => {
    if (telegramBot) {
        telegramBot.stop('SIGTERM');
    }
});
