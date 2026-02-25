require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const stream = require('stream');

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
// OVERLAY CONFIGURATION
// -----------------------------------------------------------------------------
const OVERLAY_PATH = path.join(__dirname, 'overlay', 'Family Home.mp4');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');

// Create directories if they don't exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

// -----------------------------------------------------------------------------
// VIDEO OVERLAY FUNCTION
// -----------------------------------------------------------------------------
async function applyOverlayToVideo(inputPath, outputPath) {
    try {
        console.log('🎬 Applying overlay to video...');
        
        // Check if overlay file exists
        if (!fs.existsSync(OVERLAY_PATH)) {
            throw new Error('Overlay file not found: ' + OVERLAY_PATH);
        }

        // Get overlay duration
        const { stdout: ovDur } = await execPromise(
            `ffprobe -v error -show_entries format=duration -of csv=p=0 "${OVERLAY_PATH}"`
        );
        const OVERLAY_DURATION = parseFloat(ovDur.trim());

        // Get video dimensions
        const { stdout: width } = await execPromise(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${inputPath}"`
        );
        const { stdout: height } = await execPromise(
            `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${inputPath}"`
        );
        
        const WIDTH = parseInt(width.trim());
        const HEIGHT = parseInt(height.trim());

        // Calculate bar height based on video resolution
        let BAR_HEIGHT;
        if (HEIGHT <= 360) BAR_HEIGHT = 30;
        else if (HEIGHT <= 720) BAR_HEIGHT = 45;
        else BAR_HEIGHT = 60;

        const OVERLAY_Y = HEIGHT - BAR_HEIGHT;

        // Generate unique filenames for temp files
        const timestamp = Date.now();
        const part1Path = path.join(TEMP_DIR, `part1_${timestamp}.mp4`);
        const part2Path = path.join(TEMP_DIR, `part2_${timestamp}.mp4`);
        const listPath = path.join(TEMP_DIR, `list_${timestamp}.txt`);

        // Step 1: First part with overlay
        await execPromise(
            `ffmpeg -y -i "${inputPath}" -i "${OVERLAY_PATH}" -filter_complex ` +
            `"[1:v]scale=${WIDTH}:${BAR_HEIGHT},format=rgba[ovr]; [0:v][ovr]overlay=y=${OVERLAY_Y}" ` +
            `-t ${OVERLAY_DURATION} -c:v libx264 -preset veryfast -crf 23 -an "${part1Path}"`
        );

        // Step 2: Remaining part (direct copy)
        await execPromise(
            `ffmpeg -y -i "${inputPath}" -ss ${OVERLAY_DURATION} -c copy "${part2Path}"`
        );

        // Step 3: Concatenate both parts
        const listContent = `file '${part1Path}'\nfile '${part2Path}'\n`;
        fs.writeFileSync(listPath, listContent);

        await execPromise(
            `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`
        );

        // Cleanup temp files
        try {
            if (fs.existsSync(part1Path)) fs.unlinkSync(part1Path);
            if (fs.existsSync(part2Path)) fs.unlinkSync(part2Path);
            if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        } catch (e) {
            console.log('Cleanup warning:', e.message);
        }

        console.log('✅ Overlay applied successfully');
        return true;

    } catch (error) {
        console.error('❌ Overlay error:', error.message);
        return false;
    }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTION TO CONVERT STREAM TO BUFFER
// -----------------------------------------------------------------------------
async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

function replaceCaption(caption) {
    if (!caption || !OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    
    return result;
}

function processAndCleanMessage(originalMessage) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
            const cleanedText = cleanNewsletterText(text);
            
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        delete cleanedMessage.protocolMessage;
        
        return cleanedMessage;
    } catch (error) {
        return originalMessage;
    }
}

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
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // MESSAGE HANDLER WITH VIDEO OVERLAY - FINAL WORKING VERSION
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // COMMAND HANDLER
        if (wasi_text.startsWith('!')) {
            await processCommand(wasi_sock, wasi_msg);
        }

        // AUTO FORWARD LOGIC
        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            try {
                // Check if it's a video message
                if (wasi_msg.message.videoMessage) {
                    console.log('🎥 Video received, applying overlay...');
                    
                    // Download video as stream and convert to buffer
                    const videoStream = await downloadMediaMessage(
                        wasi_msg, 
                        wasi_sock, 
                        { logger: console }
                    );
                    
                    // Convert stream to buffer
                    const videoBuffer = await streamToBuffer(videoStream);
                    
                    // Save to temp file
                    const videoPath = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
                    fs.writeFileSync(videoPath, videoBuffer);
                    
                    console.log(`✅ Video downloaded: ${videoPath}`);
                    
                    if (fs.existsSync(OVERLAY_PATH)) {
                        // Apply overlay
                        const outputPath = path.join(OUTPUT_DIR, `output_${Date.now()}.mp4`);
                        const success = await applyOverlayToVideo(videoPath, outputPath);
                        
                        if (success && fs.existsSync(outputPath)) {
                            // Send processed video to targets
                            const processedBuffer = fs.readFileSync(outputPath);
                            
                            for (const targetJid of TARGET_JIDS) {
                                try {
                                    await wasi_sock.sendMessage(targetJid, {
                                        video: processedBuffer,
                                        caption: replaceCaption(cleanNewsletterText(wasi_msg.message.videoMessage.caption || '')),
                                        mimetype: 'video/mp4'
                                    });
                                    console.log(`✅ Video with overlay sent to ${targetJid}`);
                                } catch (err) {
                                    console.error(`Failed to send to ${targetJid}:`, err.message);
                                }
                            }
                            
                            // Cleanup
                            try {
                                fs.unlinkSync(outputPath);
                                fs.unlinkSync(videoPath);
                            } catch (e) {}
                        } else {
                            // If overlay fails, forward original
                            console.log('⚠️ Overlay failed, forwarding original');
                            let relayMsg = processAndCleanMessage(wasi_msg.message);
                            
                            for (const targetJid of TARGET_JIDS) {
                                await wasi_sock.relayMessage(targetJid, relayMsg, { 
                                    messageId: wasi_sock.generateMessageTag() 
                                });
                            }
                        }
                    } else {
                        console.log('⚠️ Overlay file not found, forwarding original');
                        let relayMsg = processAndCleanMessage(wasi_msg.message);
                        
                        for (const targetJid of TARGET_JIDS) {
                            await wasi_sock.relayMessage(targetJid, relayMsg, { 
                                messageId: wasi_sock.generateMessageTag() 
                            });
                        }
                    }
                }
                // Handle other media types (images, etc.)
                else {
                    let relayMsg = processAndCleanMessage(wasi_msg.message);
                    
                    if (!relayMsg) return;

                    if (relayMsg.viewOnceMessageV2)
                        relayMsg = relayMsg.viewOnceMessageV2.message;
                    if (relayMsg.viewOnceMessage)
                        relayMsg = relayMsg.viewOnceMessage.message;

                    const isMedia = relayMsg.imageMessage ||
                        relayMsg.audioMessage ||
                        relayMsg.documentMessage ||
                        relayMsg.stickerMessage;

                    let isEmojiOnly = false;
                    if (relayMsg.conversation) {
                        const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u;
                        isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                    }

                    if (!isMedia && !isEmojiOnly) return;

                    if (relayMsg.imageMessage?.caption) {
                        relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                    }
                    if (relayMsg.documentMessage?.caption) {
                        relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                    }

                    console.log(`📦 Forwarding from ${wasi_origin}`);

                    for (const targetJid of TARGET_JIDS) {
                        try {
                            await wasi_sock.relayMessage(
                                targetJid,
                                relayMsg,
                                { messageId: wasi_sock.generateMessageTag() }
                            );
                            console.log(`✅ Message forwarded to ${targetJid}`);
                        } catch (err) {
                            console.error(`Failed to forward to ${targetJid}:`, err.message);
                        }
                    }
                }

            } catch (err) {
                console.error('Auto Forward Error:', err.message);
            }
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
        console.log('🌐 Server running on port ' + wasi_port);
        console.log('📡 Auto Forward: ' + SOURCE_JIDS.length + ' source(s) → ' + TARGET_JIDS.length + ' target(s)');
        console.log('🎥 Video Overlay: Active (Family Home.mp4)');
        console.log('✨ Message Cleaning: Active');
        console.log('🤖 Bot Commands: !ping, !jid, !gjid');
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // Check overlay file
    if (fs.existsSync(OVERLAY_PATH)) {
        console.log('✅ Overlay file found: Family Home.mp4');
    } else {
        console.warn('⚠️ Warning: Overlay file not found at: ' + OVERLAY_PATH);
        console.warn('   Please place "Family Home.mp4" in the "overlay" folder');
    }

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
