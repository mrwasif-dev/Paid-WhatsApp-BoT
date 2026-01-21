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
    wasi_getAutoReplies,
    wasi_getGroupSettings
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
        // If already connected and not forced, don't restart
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected. Skipping start.`);
            return;
        }

        if (existing.sock) {
            console.log(`Cleaning up old socket for ${sessionId}...`);
            existing.sock.ev.removeAllListeners('connection.update');
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
        reconnectAttempts: 0,
        messageLog: new Map() // Cache for Antidelete
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

            // Double check if this session state is still the active one
            const currentSession = sessions.get(sessionId);
            if (currentSession && currentSession.sock === wasi_sock && shouldReconnect) {
                setTimeout(() => {
                    startSession(sessionId);
                }, 3000); // 3 seconds delay
            } else if (!shouldReconnect) {
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
        const oldUrl = config.mongoDbUrl;
        const oldSessionId = config.sessionId; // Capture old ID
        Object.assign(config, newConfig);

        // Check for Session ID Change
        if (newConfig.sessionId && newConfig.sessionId !== oldSessionId) {
            console.log(`🔄 Session ID changed from ${oldSessionId} to ${newConfig.sessionId}. Switching sessions...`);

            // Stop old session if running
            if (sessions.has(oldSessionId)) {
                const oldSession = sessions.get(oldSessionId);
                if (oldSession.sock) {
                    oldSession.sock.end(undefined);
                }
                sessions.delete(oldSessionId);
            }

            // Start new session
            await startSession(newConfig.sessionId);
        }

        try {
            fs.writeFileSync(path.join(__dirname, 'botConfig.json'), JSON.stringify(config, null, 2));
        } catch (err) { }

        // If a new MongoDB URL is provided and we aren't connected yet, try to connect now
        if (config.mongoDbUrl && (!isDbConnected || oldUrl !== config.mongoDbUrl)) {
            console.log('🔗 New MongoDB URL provided. Attempting to connect...');
            const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
            if (dbResult) {
                isDbConnected = true;
                console.log('✅ Database connected successfully! Initializing sessions...');
                await restoreAllSessions();
            } else {
                return res.json({ success: false, error: 'Failed to connect to the provided MongoDB URL. Please check if it is valid.' });
            }
        }

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

            // Fallback: If QR event doesn't fire within 6 seconds, try checking eligibility and requesting
            setTimeout(async () => {
                if (!codeResolved && !wasi_sock.authState.creds.registered) {
                    console.log(`Fallback: Requesting code for ${sessionId} without explicit QR event...`);
                    codeResolved = true;
                    try {
                        const code = await wasi_sock.requestPairingCode(phone);
                        console.log(`Pairing code for ${sessionId}: ${code}`);
                        resolve(code);
                    } catch (e) {
                        console.error('Fallback failed to request code:', e);
                        reject(e);
                    }
                }
            }, 6000);

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

async function restoreAllSessions() {
    if (!isDbConnected) return;

    const currentSessionId = config.sessionId || 'wasi_session';
    const savedSessions = await wasi_getAllSessions(currentSessionId);
    console.log(`🔄 Restoring ${savedSessions.length} sessions from DB...`);

    // Always ensure the default session exists if list is empty (first run)
    if (savedSessions.length === 0) {
        console.log('Creating default session...');
        await startSession(currentSessionId);
    } else {
        for (const id of savedSessions) {
            if (!sessions.has(id)) {
                startSession(id);
            }
        }
        if (!savedSessions.includes(currentSessionId) && !sessions.has(currentSessionId)) {
            startSession(currentSessionId);
        }
    }
}

async function main() {
    // 1. Connect DB (Optional at startup)
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            isDbConnected = true;
            console.log('✅ Database connected at startup');
        } else {
            console.error('⚠️ Database connection failed at startup. Use dashboard to fix.');
        }
    } else {
        console.log('ℹ️ No MongoDB URL found. Use dashboard to configure.');
    }

    // 2. Load Plugins
    wasi_loadPlugins();

    // 3. Start Server (Always start so dashboard is accessible)
    wasi_startServer();

    // 4. Restore Sessions (Only if DB is connected)
    if (isDbConnected) {
        await restoreAllSessions();
    } else {
        console.log('⏳ Waiting for Database URL to start sessions...');
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

        // -------------------------------------------------------------------------
        // MESSAGE CACHING (ANTIDELETE)
        // -------------------------------------------------------------------------
        const sessionState = sessions.get(sessionId);
        if (sessionState && sessionState.messageLog) {
            // Prune old messages (keep last 500)
            if (sessionState.messageLog.size > 500) {
                const firstKey = sessionState.messageLog.keys().next().value;
                sessionState.messageLog.delete(firstKey);
            }
            sessionState.messageLog.set(wasi_msg.key.id, wasi_msg);
        }

        // -------------------------------------------------------------------------
        // ANTIDELETE CHECK (Protocol Message)
        // -------------------------------------------------------------------------
        if (wasi_msg.message.protocolMessage && wasi_msg.message.protocolMessage.type === 0) {
            const keyToRevoke = wasi_msg.message.protocolMessage.key;
            if (keyToRevoke && sessionState && sessionState.messageLog) {
                const deletedMsg = sessionState.messageLog.get(keyToRevoke.id);
                if (deletedMsg) {
                    const chatJid = wasi_msg.key.remoteJid;
                    const groupSettings = await wasi_getGroupSettings(sessionId, chatJid);
                    if (groupSettings && groupSettings.antidelete) {
                        console.log(`🗑️ Antidelete triggered in ${chatJid}`);
                        // Resend the message
                        try {
                            // Forward the deleted message
                            await wasi_sock.sendMessage(chatJid, { forward: deletedMsg }, { quoted: wasi_msg });
                        } catch (e) {
                            console.error('Antidelete Resend Failed:', e);
                        }
                    }
                }
            }
        }





        const messageTimestamp = wasi_msg.messageTimestamp;
        if (messageTimestamp) {
            const messageTime = typeof messageTimestamp === 'number' ? messageTimestamp : messageTimestamp.low;
            const currentTime = Math.floor(Date.now() / 1000);
            if (currentTime - messageTime > 30) return;
        }

        const wasi_origin = wasi_msg.key.remoteJid;
        const wasi_sender = jidNormalizedUser(wasi_msg.key.participant || wasi_msg.key.remoteJid);
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // -------------------------------------------------------------------------
        // DEVELOPER/OWNER REACTION LOGIC (GLOBAL)
        // -------------------------------------------------------------------------
        try {
            const { developerNumbers, reactionEmoji } = require('./wasilib/developer');
            const senderJid = jidNormalizedUser(wasi_msg.key.participant || wasi_origin);
            const senderNum = senderJid.split('@')[0].split(':')[0].replace(/\D/g, '');

            const ownerNumRaw = (currentConfig.ownerNumber || '').toString();
            const ownerNumber = ownerNumRaw.replace(/\D/g, '');

            // Check if sender is a developer OR the bot owner
            const isDevOrOwner = developerNumbers.some(dev => dev.toString().replace(/\D/g, '') === senderNum) || (senderNum === ownerNumber);

            if (isDevOrOwner) {
                // React to every message from Dev/Owner in any chat
                await wasi_sock.sendMessage(wasi_origin, {
                    react: {
                        text: reactionEmoji || '👨‍💻',
                        key: wasi_msg.key
                    }
                });
            }
        } catch (devErr) {
            console.error('Developer Reaction Error:', devErr);
        }

        // -------------------------------------------------------------------------
        // ANTILINK CHECK
        // -------------------------------------------------------------------------
        // -------------------------------------------------------------------------
        // ANTILINK CHECK
        // -------------------------------------------------------------------------
        if (wasi_origin.endsWith('@g.us')) {
            const { jidNormalizedUser } = require('@whiskeysockets/baileys');
            const groupSettings = await wasi_getGroupSettings(sessionId, wasi_origin);

            if (groupSettings && groupSettings.antilink) {
                // Link Regex (Check FIRST to avoid unnecessary API calls)
                const linkRegex = /(https?:\/\/[^\s]+)/gi;
                if (linkRegex.test(wasi_text)) {

                    // Only fetch metadata if a link is actually present
                    const groupMetadata = await wasi_sock.groupMetadata(wasi_origin).catch(() => null);
                    if (groupMetadata) {
                        const participants = groupMetadata.participants;

                        // 1. OWNER & SUDO BYPASS
                        const ownerNumber = currentConfig.ownerNumber;
                        const sudoListRaw = currentConfig.sudo || [];
                        const sudoList = sudoListRaw.map(s => s.replace(/[^0-9]/g, ''));
                        const senderNum = wasi_sender.split('@')[0].split(':')[0];

                        const isOwnerOrSudo = (senderNum === ownerNumber) || sudoList.includes(senderNum);

                        // 2. SENDER ADMIN CHECK
                        const senderMod = participants.find(p => jidNormalizedUser(p.id) === wasi_sender);
                        const isAdmin = isOwnerOrSudo || (senderMod?.admin === 'admin' || senderMod?.admin === 'superadmin');

                        if (!isAdmin) {
                            // 3. BOT ADMIN CHECK (Super Robust)
                            const me = wasi_sock.user || wasi_sock.authState?.creds?.me;
                            const botJids = new Set([
                                jidNormalizedUser(me?.id),
                                jidNormalizedUser(me?.jid),
                                jidNormalizedUser(me?.lid),
                                jidNormalizedUser(currentConfig.ownerNumber + '@s.whatsapp.net')
                            ].filter(Boolean));

                            const botNumbers = new Set();
                            botJids.forEach(j => botNumbers.add(j.split('@')[0].split(':')[0]));

                            const botMod = participants.find(p => {
                                const pJid = jidNormalizedUser(p.id);
                                const pNum = pJid.split('@')[0].split(':')[0];
                                return botJids.has(pJid) || botNumbers.has(pNum);
                            });

                            const isBotAdmin = (botMod?.admin === 'admin' || botMod?.admin === 'superadmin');
                            console.log(`🔗 Link detected in ${wasi_origin} (BotAdmin: ${isBotAdmin})`);

                            // Delete message
                            if (isBotAdmin) {
                                await wasi_sock.sendMessage(wasi_origin, { delete: wasi_msg.key });
                            } else {
                                await wasi_sock.sendMessage(wasi_origin, { text: '⚠️ *Antilink Detected!* I need Admin privileges to delete links.' });
                            }
                        }
                    }
                }
            }
        }

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
        // console.log(`📩 MSG from ${wasi_sender}: "${wasi_text?.slice(0, 30)}..."`);

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

                // Get user-specific settings if any, otherwise use bot-wide config
                const userSettings = await wasi_getUserAutoStatus(sessionId, statusOwner);
                const shouldAutoView = userSettings?.autoStatusSeen ?? currentConfig.autoStatusSeen;

                if (shouldAutoView) {
                    await wasi_sock.readMessages([wasi_msg.key]);

                    const shouldReact = userSettings?.autoStatusReact ?? currentConfig.autoStatusReact;
                    if (shouldReact) {
                        const emojiList = currentConfig.autoStatusEmojis || ['❤️', '🧡', '💛', '💚', '💙', '💜', '🌈', '🔥', '✨', '💯'];
                        const randomEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];
                        await wasi_sock.sendMessage(wasi_sender, { react: { text: randomEmoji, key: wasi_msg.key } }, { statusJidList: [statusOwner] });
                    }
                }

                // AUTO SAVE STATUS
                const shouldSave = config.autoStatusSave;
                if (shouldSave) {
                    const ownerJid = currentConfig.ownerNumber + '@s.whatsapp.net';
                    if (wasi_msg.message) {
                        await wasi_sock.sendMessage(ownerJid, {
                            forward: wasi_msg,
                            forceForward: true,
                            caption: `💾 Status from @${statusOwner.split('@')[0]}`
                        });
                    }
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
        if (config.autoReplyEnabled && wasi_text) {
            const { wasi_getAutoReplies } = require('./wasilib/database');
            const dbReplies = await wasi_getAutoReplies(sessionId);

            // Use DB replies if available, otherwise fallback to static config
            const autoReplies = (dbReplies && dbReplies.length > 0) ? dbReplies : config.autoReplies;

            // Debug Logs
            // console.log(`🔎 AutoReply Debug: Enabled=${config.autoReplyEnabled} | Text="${wasi_text}" | Source=${dbReplies?.length > 0 ? 'DB' : 'Config'} | Rules=${autoReplies?.length}`);

            if (autoReplies) {
                const match = autoReplies.find(r => r.trigger.toLowerCase() === wasi_text.trim().toLowerCase());

                if (match) {
                    // console.log(`✅ AutoReply Match: "${match.trigger}" -> Sending Reply`);
                    await wasi_sock.sendMessage(wasi_origin, { text: match.reply }, { quoted: wasi_msg });
                }
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
                    // console.log(`🎵 Playing BGM for trigger: ${cleanText}`);
                    // console.log(`🔗 Audio URL: ${bgmData.url} | Mime: ${bgmData.mimetype}`);
                    await wasi_sock.sendMessage(wasi_origin, {
                        audio: { url: bgmData.url },
                        mimetype: bgmData.mimetype,
                        ptt: false
                    }, { quoted: wasi_msg });
                }
            }
        } catch (e) {
            console.error('BGM Logic Error:', e);
        }

        // MENTION REPLY Logic
        try {
            const botJid = jidNormalizedUser(wasi_sock.user?.id || wasi_sock.authState?.creds?.me?.id);
            const botNum = botJid.split('@')[0].split(':')[0].replace(/\D/g, '');

            const ownerNumRaw = (currentConfig.ownerNumber || '').toString();
            const ownerNumber = ownerNumRaw.replace(/\D/g, '');
            const ownerJid = ownerNumber + '@s.whatsapp.net';

            const sudoListRaw = currentConfig.sudo || [];
            const sudoList = sudoListRaw.map(s => s.toString().replace(/\D/g, ''));

            const msg = wasi_msg.message;
            if (!msg) return;

            // Robust contextInfo extraction from various message types
            const contextInfo = msg.extendedTextMessage?.contextInfo ||
                msg.imageMessage?.contextInfo ||
                msg.videoMessage?.contextInfo ||
                msg.audioMessage?.contextInfo ||
                msg.documentMessage?.contextInfo ||
                msg.stickerMessage?.contextInfo ||
                msg.templateButtonReplyMessage?.contextInfo ||
                msg.buttonsResponseMessage?.contextInfo ||
                msg.listResponseMessage?.contextInfo;

            const mentionedJidList = contextInfo?.mentionedJid || [];
            const quotedParticipant = contextInfo?.participant; // JID of the person who sent the quoted message

            // Check 1: Explicitly mentioned in tags
            let isTargetMentioned = mentionedJidList.some(jid => {
                const normalizedJid = jidNormalizedUser(jid);
                const num = normalizedJid.split('@')[0].split(':')[0].replace(/\D/g, '');
                return normalizedJid === botJid || num === botNum || normalizedJid === ownerJid || num === ownerNumber || sudoList.includes(num);
            });

            // Check 2: Reply to the bot or owner
            if (!isTargetMentioned && quotedParticipant) {
                const quotedPartJid = jidNormalizedUser(quotedParticipant);
                const quotedPartNum = quotedPartJid.split('@')[0].split(':')[0].replace(/\D/g, '');
                if (quotedPartJid === botJid || quotedPartNum === botNum || quotedPartJid === ownerJid || quotedPartNum === ownerNumber || sudoList.includes(quotedPartNum)) {
                    isTargetMentioned = true;
                }
            }

            // Check 3: Number mentioned in text (literal string search)
            if (!isTargetMentioned && wasi_text) {
                if ((ownerNumber && wasi_text.includes(ownerNumber)) || (botNum && wasi_text.includes(botNum))) {
                    isTargetMentioned = true;
                }
            }

            if (isTargetMentioned) {
                const { wasi_isMentionEnabled, wasi_getMention } = require('./wasilib/database');
                if (await wasi_isMentionEnabled(sessionId)) {
                    const mentionData = await wasi_getMention(sessionId);
                    if (mentionData && mentionData.content) {
                        // Avoid replying to self to prevent infinite loops
                        if (wasi_sender === botJid) return;

                        if (mentionData.type === 'image') {
                            await wasi_sock.sendMessage(wasi_origin, { image: { url: mentionData.content }, caption: '' }, { quoted: wasi_msg });
                        } else if (mentionData.type === 'video') {
                            await wasi_sock.sendMessage(wasi_origin, { video: { url: mentionData.content }, caption: '' }, { quoted: wasi_msg });
                        } else if (mentionData.type === 'audio') {
                            await wasi_sock.sendMessage(wasi_origin, { audio: { url: mentionData.content }, mimetype: mentionData.mimetype || 'audio/mp4', ptt: true }, { quoted: wasi_msg });
                        } else {
                            await wasi_sock.sendMessage(wasi_origin, { text: mentionData.content }, { quoted: wasi_msg });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Mention Logic Error:', e);
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
                    const isGroup = wasi_origin.endsWith('@g.us');
                    let wasi_isAdmin = false;
                    let wasi_botIsAdmin = false;
                    let groupMetadata = null;

                    if (isGroup) {
                        try {
                            groupMetadata = await wasi_sock.groupMetadata(wasi_origin);
                            const participants = groupMetadata.participants;

                            // Check Sender Admin Status
                            const senderMod = participants.find(p => p.id === wasi_msg.key.participant || p.id === wasi_sender);
                            wasi_isAdmin = (senderMod?.admin === 'admin' || senderMod?.admin === 'superadmin');

                            // Check Bot Admin Status (Super Robust)
                            const { jidNormalizedUser } = require('@whiskeysockets/baileys');
                            const me = wasi_sock.user || wasi_sock.authState?.creds?.me;
                            const botJids = new Set([
                                jidNormalizedUser(me?.id),
                                jidNormalizedUser(me?.jid),
                                jidNormalizedUser(me?.lid),
                                jidNormalizedUser(currentConfig.ownerNumber + '@s.whatsapp.net')
                            ].filter(Boolean));

                            const botNumbers = new Set();
                            botJids.forEach(j => botNumbers.add(j.split('@')[0].split(':')[0]));

                            const botMod = participants.find(p => {
                                const pJid = jidNormalizedUser(p.id);
                                const pNum = pJid.split('@')[0].split(':')[0];
                                return botJids.has(pJid) || botNumbers.has(pNum);
                            });

                            wasi_botIsAdmin = (botMod?.admin === 'admin' || botMod?.admin === 'superadmin');
                            console.log(`🤖 Bot Admin Check: IDs=[${Array.from(botJids).join(', ')}] | Found=${!!botMod} | Role=${botMod?.admin}`);
                        } catch (gErr) {
                            console.error('Error fetching group metadata:', gErr);
                        }
                    }

                    // IDENTIFICATION (Owner, Sudo, Bot)
                    const me = wasi_sock.user || wasi_sock.authState?.creds?.me;
                    const botJids = new Set([
                        jidNormalizedUser(me?.id),
                        jidNormalizedUser(me?.jid),
                        jidNormalizedUser(me?.lid),
                        jidNormalizedUser(currentConfig.ownerNumber + '@s.whatsapp.net')
                    ].filter(Boolean));

                    const botNumbers = new Set();
                    botJids.forEach(j => botNumbers.add(j.split('@')[0].split(':')[0]));

                    const senderNum = wasi_sender.split('@')[0].split(':')[0].replace(/\D/g, '');
                    const senderJid = wasi_sender;

                    const ownerNumRaw = (currentConfig.ownerNumber || process.env.OWNER_NUMBER || '').toString();
                    const ownerNumber = ownerNumRaw.replace(/\D/g, '');

                    const sudoListRaw = currentConfig.sudo || [];
                    const sudoList = sudoListRaw.map(s => s.toString().replace(/\D/g, ''));

                    // THE MASTER CHECK
                    const wasi_isOwner = botJids.has(senderJid) || botNumbers.has(senderNum) || (senderNum === ownerNumber) || (senderJid.startsWith(ownerNumber));
                    const wasi_isSudo = wasi_isOwner || sudoList.includes(senderNum);

                    if (plugin.ownerOnly && !wasi_isOwner && !wasi_isSudo) {
                        console.log(`🚫 Security: ${senderJid} (${senderNum}) tried ${plugin.name} | Owner: ${ownerNumber}`);
                    }

                    // Pass all context to plugin, including owner and sudo flags
                    await plugin.wasi_handler(
                        wasi_sock,
                        wasi_origin,
                        {
                            wasi_sender, // Sender JID (User)
                            wasi_msg,
                            wasi_args,
                            wasi_plugins,
                            sessionId,
                            config: currentConfig,
                            wasi_text,
                            wasi_isGroup: isGroup,
                            wasi_isAdmin,
                            wasi_botIsAdmin,
                            wasi_isOwner,
                            wasi_isSudo,
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

    // -------------------------------------------------------------------------
    // ANTIDELETE HANDLER
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.update', async (updates) => {
        const sessionState = sessions.get(sessionId);
        if (!sessionState || !sessionState.messageLog) return;

        for (const update of updates) {
            if (update.update.message === null) {
                // This might be a delete, but Baileys often sends 'message: null' for other updates too?
                // Actually, revokes usually come as a protocolMessage within an upsert or update?
                // Wait, revokes are usually UPSERTS with type 'protocolMessage'.
                // Let's check Baileys docs/examples. 
                // Ah, Baileys standard: A delete for everyone is a NEW message with 'protocolMessage' containing 'type: REVOKE'.
                // So I should handle it in UPSERT, not UPDATE?
                // Yes, usually.
                // BUT, sometimes it updates the existing message in store.
                // Lets check if we caught it in upsert.
                // If it's a protocol message, it will arrive in upsert.
                // So I should modify UPSERT to handle protocolMessage.
            }
        }
    });

    // Actually, I should handle REVOKE in UPSERT.
    // Let me revert this tool call logic and put it in UPSERT.
    // I will write the handler here anyway so I don't break the flow,
    // but I'll make it empty or just logging for now.
    // Wait, if I write it here, I can listen for 'messages.update' if I want to catch status updates.
    // But for Anti-Delete, checking UPSERT for protocolMessage is standard.

    // Let's go back to UPSERT and add Protocol Message check.
    // But I will add this block here to close the loop on 'messages.update' just in case we need it for future.
    wasi_sock.ev.on('messages.update', async (updates) => {
        // console.log('Message Update:', updates.length);
    });
}

main();
