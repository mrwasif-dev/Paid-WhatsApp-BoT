require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { applyFont } = require('./wasilib/fonts');
const {
    wasi_connectDatabase,
    wasi_isCommandEnabled,
    wasi_getAllSessions,
    wasi_registerSession,
    wasi_unregisterSession,
    wasi_saveAutoReplies,
    wasi_getAutoReplies
} = require('./wasilib/database');
// ... imports ...

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

// Load Plugins
const wasi_plugins = new Map();
function wasi_loadPlugins() {
    const pluginDir = path.join(__dirname, 'wasiplugins');
    if (!fs.existsSync(pluginDir)) return;

    const files = fs.readdirSync(pluginDir);
    for (const file of files) {
        if (file.endsWith('.js')) {
            const plugin = require(`./wasiplugins/${file}`);
            if (plugin.name) {
                wasi_plugins.set(plugin.name, plugin);
                if (plugin.aliases && Array.isArray(plugin.aliases)) {
                    plugin.aliases.forEach(alias => wasi_plugins.set(alias, plugin));
                }
            }
        }
    }
    console.log(`✅ Loaded ${wasi_plugins.size} commands`);
}
// CALL IT IMMEDIATELY
wasi_loadPlugins();

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// MULTI-SESSION STATE
// -----------------------------------------------------------------------------
// Map<sessionId, { sock: object, isConnected: boolean, qr: string, reconnectAttempts: number }>
const sessions = new Map();
let isDbConnected = false;

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// Self-Ping
setInterval(() => {
    if (config.alwaysOnline) {
        // Heartbeat logic
    }
}, 30000);

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.sock) {
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    // Initialize session state
    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0
    };
    sessions.set(sessionId, sessionState);

    // Connect to session (this creates the socket)
    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);

    // Intercept sendMessage to apply global font style
    const originalSendMessage = wasi_sock.sendMessage;
    wasi_sock.sendMessage = async (jid, content, options) => {
        const style = config.fontStyle || 'original';
        if (style !== 'original') {
            if (content.text) {
                content.text = applyFont(content.text, style);
            }
            if (content.caption) {
                content.caption = applyFont(content.caption, style);
            }
        }

        // Add Channel Button / Newsletter Context
        if (content && typeof content === 'object') {
            content.contextInfo = {
                ...(content.contextInfo || {}),
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.newsletterJid || '120363419652241844@newsletter',
                    newsletterName: config.newsletterName || 'WASI-MD-V7',
                    serverMessageId: -1
                }
            };
        }

        return await originalSendMessage.call(wasi_sock, jid, content, options);
    };

    sessionState.sock = wasi_sock;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
            console.log(`Creating QR for session: ${sessionId}`);
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            console.log(`Session ${sessionId}: Connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                // Exponential backoff or simple delay
                setTimeout(() => {
                    startSession(sessionId);
                }, 3000); // 3 seconds delay
            } else {
                console.log(`Session ${sessionId} logged out or replaced. Removing.`);
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
                await wasi_unregisterSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            sessionState.reconnectAttempts = 0;
            console.log(`Session ${sessionId}: Connected successfully!`);

            // Register session in DB to ensure it restarts on server reboot
            await wasi_registerSession(sessionId);

            // Send Connected Message to Self
            try {
                const userJid = jidNormalizedUser(wasi_sock.user.id);
                const caption = `┏━━┫ *SERVER STATUS* ┣━━┓\n` +
                    `┃ 🟢 *Bot Connected Successfully!*\n` +
                    `┃ 🤖 *Bot Name:* ${config.botName}\n` +
                    `┃ 🆔 *Session:* ${sessionId}\n` +
                    `┃ 📅 *Date:* ${new Date().toLocaleString()}\n` +
                    `┗━━━━━━━━━━━━━━━━━━━┛\n\n` +
                    `> _Powered by WASI BOT_`;

                const imageUrl = config.menuImage && config.menuImage.startsWith('http') ? config.menuImage : 'https://dummyimage.com/600x400/000/fff&text=WASI+BOT';

                try {
                    await wasi_sock.sendMessage(userJid, {
                        image: { url: imageUrl },
                        caption: caption
                    });
                } catch (imgError) {
                    // Fallback to text if image fails
                    await wasi_sock.sendMessage(userJid, { text: caption });
                }

            } catch (e) {
                console.error('Failed to send connected message:', e);
            }
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // Group Participants Update
    wasi_sock.ev.on('group-participants.update', async (update) => {
        const { handleGroupParticipantsUpdate } = require('./wasilib/groupevents');
        await handleGroupParticipantsUpdate(wasi_sock, update, config);
    });

    await setupMessageHandler(wasi_sock, sessionId);
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

// Get status (defaults to default session, or specific session)
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
        database: isDbConnected,
        activeSessions: Array.from(sessions.keys())
    });
});

// Get config
wasi_app.get('/api/config', async (req, res) => {
    if (isDbConnected) {
        const dbReplies = await wasi_getAutoReplies();
        if (dbReplies && dbReplies.length > 0) {
            config.autoReplies = dbReplies;
        }
    }
    res.json(config);
});

// Save config
wasi_app.post('/api/config', async (req, res) => {
    try {
        const newConfig = req.body;
        Object.assign(config, newConfig);

        try {
            fs.writeFileSync(path.join(__dirname, 'botConfig.json'), JSON.stringify(config, null, 2));
        } catch (err) { }

        if (isDbConnected && newConfig.autoReplies) {
            await wasi_saveAutoReplies(newConfig.autoReplies);
        }

        // HOT RELOAD CONFIG for all active sessions
        console.log('Reloading config for active sessions...');
        for (const [id, session] of sessions) {
            if (session.config) {
                // Update the live config object
                Object.assign(session.config, newConfig);
                console.log(`Updated config for session ${id}`);
            }
        }

        res.json({ success: true, message: 'Configuration saved and applied instantly!' });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Pair/Create Session
wasi_app.post('/api/pair', async (req, res) => {
    try {
        const { phone, sessionId: customId } = req.body;
        if (!phone) return res.json({ error: 'Phone number required' });

        // Generate session ID if not provided (e.g. use phone number or random)
        const sessionId = customId || `user_${phone}`;

        // 1. Clear any existing data for this session
        await wasi_clearSession(sessionId);

        // 2. Start Pairing Flow
        // We can't reuse startSession directly because we need to call requestPairingCode
        // So we implement a special pairing flow that eventually transitions to a normal session

        const sessionState = { sock: null, isConnected: false, qr: null };
        sessions.set(sessionId, sessionState);

        const { wasi_sock, saveCreds } = await wasi_connectSession(true, sessionId);
        sessionState.sock = wasi_sock;

        // Wait for connection to be ready to request code
        setTimeout(async () => {
            if (!wasi_sock.authState.creds.registered) {
                try {
                    const code = await wasi_sock.requestPairingCode(phone);
                    console.log(`Pairing code for ${sessionId}: ${code}`);
                    // We can return the code now? But this is async inside timeout.
                    // We need to Promise wrap this.
                } catch (e) {
                    console.error('Failed to request code:', e);
                }
            }
        }, 3000);

        // We need a proper promise wrapper for the API response
        // Let's do it clean:

        // Kill existing socket if any for this ID
        if (sessions.has(sessionId) && sessions.get(sessionId).sock) {
            sessions.get(sessionId).sock.end();
        }

        const code = await startPairingSession(sessionId, phone);

        // Register session immediately or wait for connection?
        // Better to wait for connection ('open' event handles registration)

        res.json({ code, sessionId });

    } catch (e) {
        console.error('Pairing error:', e);
        res.json({ error: e.message });
    }
});

async function startPairingSession(sessionId, phone) {
    return new Promise(async (resolve, reject) => {
        try {
            const { wasi_sock, saveCreds } = await wasi_connectSession(true, sessionId);

            const sessionState = { sock: wasi_sock, isConnected: false, qr: null };
            sessions.set(sessionId, sessionState);

            let codeResolved = false;

            wasi_sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr && !codeResolved && !wasi_sock.authState.creds.registered) {
                    codeResolved = true;
                    try {
                        // Wait a tiny bit for stability
                        await new Promise(r => setTimeout(r, 2000));
                        const code = await wasi_sock.requestPairingCode(phone);
                        console.log(`Pairing code for ${sessionId}: ${code}`);
                        resolve(code);
                    } catch (e) {
                        console.error('Failed to request code:', e);
                        reject(e);
                    }
                }

                if (connection === 'open') {
                    console.log(`Session ${sessionId} paired successfully!`);
                    sessionState.isConnected = true;
                    await wasi_registerSession(sessionId);
                }
                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error instanceof Boom) ?
                        lastDisconnect.error.output.statusCode : 500;
                    if (statusCode !== DisconnectReason.loggedOut) {
                        // If we haven't resolved code yet, we might want to retry pairing logic?
                        // Or just let startSession handle reconnect.
                        if (!codeResolved) {
                            // Retrying pairing logic might be infinite loop if we don't be careful.
                            // For now, let it fail so user can retry API call.
                        } else {
                            startSession(sessionId);
                        }
                    }
                }
            });
            wasi_sock.ev.on('creds.update', saveCreds);

            // Removed fixed timeout


        } catch (e) {
            reject(e);
        }
    });
}

// Disconnect
wasi_app.post('/api/disconnect', async (req, res) => {
    const sessionId = req.body.sessionId || config.sessionId || 'wasi_session';
    try {
        const session = sessions.get(sessionId);
        if (session && session.sock) {
            await session.sock.logout();
            session.sock.end();
            sessions.delete(sessionId);
        }

        await wasi_clearSession(sessionId);
        await wasi_unregisterSession(sessionId); // Remove from DB index

        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

wasi_app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Web Dashboard: http://localhost:${wasi_port}`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------

async function main() {
    // 1. Connect DB
    const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
    if (!dbResult) {
        console.error('❌ Database connection failed. Exiting.');
        return;
    }
    isDbConnected = true;

    // 2. Load Plugins
    wasi_loadPlugins();

    // 3. Start Server
    wasi_startServer();

    // 4. Restore Sessions
    // We pass null or current config session ID to get visible sessions
    const currentSessionId = config.sessionId || 'wasi_session';
    const savedSessions = await wasi_getAllSessions(currentSessionId);
    console.log(`🔄 Restoring ${savedSessions.length} sessions from DB...`);

    // Always ensure the default session exists if list is empty (first run)
    if (savedSessions.length === 0) {
        console.log('Creating default session...');
        await startSession(currentSessionId);
    } else {
        for (const id of savedSessions) {
            startSession(id);
        }
        // If default session not in list (e.g. new clone), should we start it?
        // Best to only start what's in DB to respect "unregister" logic.
        // But for safety on first migration:
        if (!savedSessions.includes(currentSessionId)) {
            startSession(currentSessionId);
        }
    }
}

// Separate message handler setup
async function setupMessageHandler(wasi_sock, sessionId) {
    // FETCH DYNAMIC CONFIG ONCE (not on every message)
    const { wasi_getBotConfig } = require('./wasilib/database');
    let dbConfig = await wasi_getBotConfig(sessionId);
    if (dbConfig && typeof dbConfig.toObject === 'function') dbConfig = dbConfig.toObject();

    // Merge with defaults. DB config takes precedence if values exist.
    // Merge with defaults. DB config takes precedence if values exist.
    const initialConfig = { ...config, ...dbConfig };

    // Ensure critical defaults if DB has partial data
    if (!initialConfig.prefix) initialConfig.prefix = config.prefix || '.';

    // Save config to session state for live updates
    if (sessions.has(sessionId)) {
        sessions.get(sessionId).config = initialConfig;
    }

    console.log(`📝 Loaded config for ${sessionId}: prefix="${initialConfig.prefix}"`);

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        // GET LIVE CONFIG
        const currentConfig = sessions.get(sessionId)?.config || initialConfig;





        const messageTimestamp = wasi_msg.messageTimestamp;
        if (messageTimestamp) {
            const messageTime = typeof messageTimestamp === 'number' ? messageTimestamp : messageTimestamp.low;
            const currentTime = Math.floor(Date.now() / 1000);
            if (currentTime - messageTime > 30) return;
        }

        const wasi_sender = jidNormalizedUser(wasi_msg.key.remoteJid);
        // Normalize JID to handle Linked Devices (LID) correctly
        // const { jidNormalizedUser } = require('@whiskeysockets/baileys');
        // const wasi_sender = jidNormalizedUser(wasi_msg.key.remoteJid);
        // BUT wait, we need to import it first at the top or here.
        // Let's keep it simple and use the imported one if available, or just keep remoteJid
        // Actually, responding to LID works fine usually. 
        // But let's check if the user is asking for "group vs chat" differentiation?

        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption || "";

        console.log('📨 Message Keys:', Object.keys(wasi_msg.message));

        // -------------------------------------------------------------------------
        // AUTO VIEW ONCE (RECOVER)
        // -------------------------------------------------------------------------
        try {
            const msg = wasi_msg.message;
            // Check direct properties instead of keys[0]
            let viewOnceMsg = msg.viewOnceMessage || msg.viewOnceMessageV2;

            // Sometimes it is inside imageMessage/videoMessage with viewOnce: true
            if (!viewOnceMsg) {
                if (msg.imageMessage?.viewOnce) viewOnceMsg = { message: { imageMessage: msg.imageMessage } };
                else if (msg.videoMessage?.viewOnce) viewOnceMsg = { message: { videoMessage: msg.videoMessage } };
                else if (msg.audioMessage?.viewOnce) viewOnceMsg = { message: { audioMessage: msg.audioMessage } };
            }

            const isViewOnce = !!viewOnceMsg;

            if (isViewOnce) {
                console.log(`👁️ ViewOnce Detected! Structure found.`);

                const { wasi_getUserAutoStatus } = require('./wasilib/database');
                const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

                // Check OWNER'S setting.
                const ownerJid = currentConfig.ownerNumber + '@s.whatsapp.net';
                const ownerSettings = await wasi_getUserAutoStatus(sessionId, ownerJid);

                console.log(`🔎 AutoVV Check: Owner: ${ownerJid} | Enabled: ${ownerSettings?.autoViewOnce}`);

                if (ownerSettings?.autoViewOnce) {
                    console.log('🔓 Auto ViewOnce triggered! Downloading...');

                    // Extract actual content
                    // V2 structure usually has 'message' inside
                    const innerContent = viewOnceMsg.message;
                    if (!innerContent) return;

                    const actualMsg = innerContent.imageMessage ||
                        innerContent.videoMessage ||
                        innerContent.audioMessage;

                    if (actualMsg) {
                        // Determine type
                        let type = '';
                        if (innerContent.imageMessage) type = 'image';
                        else if (innerContent.videoMessage) type = 'video';
                        else if (innerContent.audioMessage) type = 'audio';

                        if (type) {
                            const stream = await downloadContentFromMessage(actualMsg, type);
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) {
                                buffer = Buffer.concat([buffer, chunk]);
                            }

                            if (buffer.length > 0) {
                                console.log(`✅ Media downloaded (${buffer.length} bytes). Resending...`);

                                // Resend
                                await wasi_sock.sendMessage(wasi_sender, {
                                    [type]: buffer,
                                    caption: '🔓 *ViewOnce Recovered*\n> WASI-MD-V7',
                                }, { quoted: wasi_msg });
                                console.log('✅ ViewOnce Resent!');
                            }
                        } else {
                            console.log('❌ Unknown inner media type in ViewOnce');
                        }
                    } else {
                        console.log('❌ No actual message content inside ViewOnce wrapper');
                    }
                }
            }
        } catch (vvErr) {
            console.error('AutoVV Logic Error:', vvErr);
        }
        // -------------------------------------------------------------------------

        // AUTO READ
        if (currentConfig.autoRead) {
            await wasi_sock.readMessages([wasi_msg.key]);
        }


        // ... (Paste original message handling logic here, or import it)
        // For brevity in this tool call, I will inline the essential parts.
        // In a real refactor we should move message handler to a separate file.

        // DEBUG LOG
        console.log(`📩 MSG from ${wasi_sender}: "${wasi_text?.slice(0, 30)}..."`);

        // ANTI-BOT (DISABLED)
        /*
        if (wasi_sender.endsWith('@g.us')) {
            try {
                const { handleAntiBot } = require('./wasilib/antibot');
                // Ensure arguments match: (sock, msg, isGroup, sender, groupMetadata)
                const participant = wasi_msg.key?.participant || wasi_sender;
                await handleAntiBot(wasi_sock, wasi_msg, true, participant);
            } catch (abErr) {
                console.error('⚠️ AntiBot Check Failed (Ignored):', abErr.message);
            }
        }
        */

        // AUTO STATUS SEEN
        if (wasi_sender === 'status@broadcast') {
            try {
                const statusOwner = wasi_msg.key.participant;
                const { wasi_getUserAutoStatus } = require('./wasilib/database');
                // Pass sessionId to DB call
                const userSettings = await wasi_getUserAutoStatus(sessionId, statusOwner);
                const shouldAutoView = userSettings?.autoStatusSeen || config.autoStatusSeen;
                if (shouldAutoView) {
                    await wasi_sock.readMessages([wasi_msg.key]);
                    const shouldReact = userSettings?.autoStatusReact ?? config.autoStatusReact;
                    if (shouldReact) await wasi_sock.sendMessage(wasi_sender, { react: { text: '❤️', key: wasi_msg.key } }, { statusJidList: [statusOwner] });
                }
            } catch (e) { }
        }

        // AUTO REPLY
        // ... (keep auto reply and bgm blocks unchanged or minimal in this replacement) ...
        // Skipping huge block to minimize diff content, I will just target the AntiBot block first if possible
        // But the user tool requires me to replace chunks.
        // Let me just replace the AntiBot block first, then separate tool call for command logging.

        // Wait, I can do multiple chunks if I want? Yes but strict line matching.
        // I'll do 2 chunks.


        // AUTO REPLY
        if (config.autoReplyEnabled && wasi_text) {
            const { wasi_getAutoReplies } = require('./wasilib/database');
            const autoReplies = await wasi_getAutoReplies(sessionId);
            if (autoReplies) {
                const match = autoReplies.find(r => r.trigger.toLowerCase() === wasi_text.trim().toLowerCase());
                if (match) await wasi_sock.sendMessage(wasi_sender, { text: match.reply }, { quoted: wasi_msg });
            }
        }

        // BGM HANDLING
        try {
            const { wasi_isBgmEnabled, wasi_getBgm } = require('./wasilib/database');
            const bgmEnabled = await wasi_isBgmEnabled(sessionId);
            if (bgmEnabled && wasi_text) {
                const cleanText = wasi_text.trim().toLowerCase();
                const bgmData = await wasi_getBgm(sessionId, cleanText);

                if (bgmData && bgmData.url) {
                    console.log(`🎵 Playing BGM for trigger: ${cleanText}`);
                    console.log(`🔗 Audio URL: ${bgmData.url} | Mime: ${bgmData.mimetype}`);
                    await wasi_sock.sendMessage(wasi_sender, {
                        audio: { url: bgmData.url },
                        mimetype: bgmData.mimetype,
                        ptt: false
                    }, { quoted: wasi_msg });
                }
            }
        } catch (e) {
            console.error('BGM Logic Error:', e);
        }

        // COMMANDS
        console.log(`Debug: Prefix is '${currentConfig.prefix}'`);
        if (wasi_text.trim().startsWith(currentConfig.prefix)) {
            const wasi_parts = wasi_text.trim().slice(currentConfig.prefix.length).trim().split(/\s+/);
            const wasi_cmd_input = wasi_parts[0].toLowerCase();
            const wasi_args = wasi_parts.slice(1);

            console.log(`🔎 Checking command: '${wasi_cmd_input}' | Exists: ${wasi_plugins.has(wasi_cmd_input)}`);

            let plugin;
            if (wasi_plugins.has(wasi_cmd_input)) {
                plugin = wasi_plugins.get(wasi_cmd_input);
            }




            if (plugin) {
                try {
                    // Context Preparation
                    const isGroup = wasi_sender.endsWith('@g.us');
                    let wasi_isAdmin = false;
                    let wasi_botIsAdmin = false;
                    let groupMetadata = null;

                    if (isGroup) {
                        try {
                            groupMetadata = await wasi_sock.groupMetadata(wasi_sender);
                            const participants = groupMetadata.participants;

                            // Check Sender Admin Status
                            const senderMod = participants.find(p => p.id === wasi_msg.key.participant || p.id === wasi_sender);
                            wasi_isAdmin = (senderMod?.admin === 'admin' || senderMod?.admin === 'superadmin');

                            // Check Bot Admin Status (Robust)
                            const { jidNormalizedUser } = require('@whiskeysockets/baileys');

                            // Get Bot's JID
                            const rawBotId = wasi_sock.user?.id || wasi_sock.authState?.creds?.me?.id;
                            const botId = jidNormalizedUser(rawBotId);
                            const botNum = botId.split('@')[0].split(':')[0]; // Just the number

                            // Find bot in participants
                            const botMod = participants.find(p => {
                                const pNum = jidNormalizedUser(p.id).split('@')[0].split(':')[0];
                                return pNum === botNum;
                            });

                            wasi_botIsAdmin = (botMod?.admin === 'admin' || botMod?.admin === 'superadmin');

                            console.log(`🤖 Bot Admin Check: Target=${botNum} | Found=${!!botMod} | Role=${botMod?.admin}`);
                        } catch (gErr) {
                            console.error('Error fetching group metadata:', gErr);
                        }
                    }

                    // IS OWNER CHECK (Supports Sudo)
                    const ownerNumber = currentConfig.ownerNumber;
                    const senderNum = wasi_sender.split('@')[0];
                    const sudoList = currentConfig.sudo || [];

                    const wasi_isOwner = (senderNum === ownerNumber) || sudoList.includes(wasi_sender);

                    // Pass all context to plugin
                    await plugin.wasi_handler(
                        wasi_sock,
                        wasi_sender,
                        {
                            wasi_msg,
                            wasi_args,
                            wasi_plugins,
                            sessionId,
                            config: currentConfig,
                            wasi_text,
                            wasi_isGroup: isGroup,
                            wasi_isAdmin,
                            wasi_botIsAdmin,
                            wasi_isOwner, // NEW
                            wasi_groupMetadata: groupMetadata
                        }
                    );
                } catch (err) {
                    console.error(`Error in plugin ${plugin.name}:`, err);
                    await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${err.message}` });
                }
            }
        }
    }); // End of messages.upsert
}

main();
