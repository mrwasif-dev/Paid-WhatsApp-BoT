require('dotenv').config();
const {
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase, wasi_isCommandEnabled } = require('./wasilib/database');
const config = require('./wasi');

// Load persistent replies if available
// Load persistent config
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        // Merge saved config into runtime config
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
}

const QRCode = require('qrcode');

// Global state for web dashboard
let currentQR = null;
let isConnected = false;
let isDbConnected = false;
let currentSock = null;
let pendingPairingPhone = null;

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route for Uptime Monitors
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// Self-Ping to keep connection active (optional, helps with some idle timeouts)
setInterval(() => {
    if (config.alwaysOnline) {
        // Just a console heartbeat
        // console.log('Heartbeat...'); 
    }
}, 30000);

// API: Get status and QR code
wasi_app.get('/api/status', async (req, res) => {
    let qrDataUrl = null;
    if (currentQR) {
        try {
            qrDataUrl = await QRCode.toDataURL(currentQR, { width: 256 });
        } catch (e) { }
    }
    res.json({
        connected: isConnected,
        qr: qrDataUrl,
        database: isDbConnected
    });
});

// API: Get config
wasi_app.get('/api/config', async (req, res) => {
    // If DB connected, try to sync replies
    if (isDbConnected) {
        const { wasi_getAutoReplies } = require('./wasilib/database');
        const dbReplies = await wasi_getAutoReplies();
        if (dbReplies && dbReplies.length > 0) {
            config.autoReplies = dbReplies;
        }
    }
    res.json(config); // Send entire config object
});

// API: Save config (updates runtime, saves to JSON, restarts bot)
wasi_app.post('/api/config', async (req, res) => {
    try {
        const newConfig = req.body;

        // Merge into runtime config
        Object.assign(config, newConfig);

        // Save to botConfig.json
        try {
            fs.writeFileSync(path.join(__dirname, 'botConfig.json'), JSON.stringify(config, null, 2));
        } catch (err) {
            console.error('Error saving botConfig.json:', err);
        }

        // Save Auto Replies to MongoDB if connected
        const { wasi_saveAutoReplies } = require('./wasilib/database');
        if (isDbConnected && newConfig.autoReplies) {
            await wasi_saveAutoReplies(newConfig.autoReplies);
        }

        // Write legacy .env file (optional but good for some environments)
        const envContent = `PORT=${wasi_port}
BOT_NAME=${config.botName}
MODE=${config.mode}
OWNER_NUMBER=${config.ownerNumber}
BOT_MENU_IMAGE_URL=${config.menuImage || ''}
MONGODB_URI=${config.mongoDbUrl || ''}
`;
        fs.writeFileSync(path.join(__dirname, '.env'), envContent);

        console.log('Config updated. Restarting bot session...');

        // Restart Bot Logic
        if (currentSock) {
            currentSock.end(undefined);
            currentSock = null;
        }

        // Small delay to ensure clean socket close
        setTimeout(() => {
            wasi_startBot();
        }, 2000);

        res.json({ success: true, message: 'Configuration saved. Bot is restarting...' });
    } catch (e) {
        console.error('Config save error:', e);
        res.json({ success: false, error: e.message });
    }
});

// API: Request pairing code
wasi_app.post('/api/pair', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.json({ error: 'Phone number required' });
        }

        pendingPairingPhone = phone;

        // Restart bot with pairing code mode
        if (currentSock) {
            try { currentSock.end(); } catch (e) { }
        }

        // Delete old session for fresh pairing (Both DB and Local)
        await wasi_clearSession();
        const authDir = path.join(__dirname, 'auth_info');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }

        // Start bot and get pairing code
        const code = await wasi_startBotWithPairing(phone);
        res.json({ code });
    } catch (e) {
        console.error('Pairing error:', e);
        res.json({ error: e.message || 'Failed to get pairing code' });
    }
});

// API: Disconnect
wasi_app.post('/api/disconnect', async (req, res) => {
    try {
        if (currentSock) {
            await currentSock.logout();
        }
        // Delete session (Both DB and Local)
        await wasi_clearSession();
        const authDir = path.join(__dirname, 'auth_info');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        isConnected = false;
        currentQR = null;
        res.json({ success: true });

        // Restart bot
        setTimeout(() => wasi_startBot(), 1000);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Fallback to index.html
wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Web Dashboard: http://localhost:${wasi_port}`);
        console.log(`📱 Configure and connect via the dashboard above\n`);
    });
}

async function wasi_startBot() {
    const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
    if (!dbResult) {
        console.error('❌ database connection failed. Cannot start bot.');
        // We do not exit process here to allow retry logic if needed, 
        // but for Heroku it's often better to crash and restart or wait.
        // Let's just return to stop execution of further steps.
        return;
    }
    isDbConnected = !!dbResult;
    const { wasi_sock, saveCreds } = await wasi_connectSession();
    currentSock = wasi_sock; // Store for API access

    let isReconnecting = false;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            isConnected = false;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            // Don't reconnect if logged out or replaced by another session
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut &&
                statusCode !== 440; // 440 = conflict/replaced

            console.log(`Wasi Bot: Connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);

            if (shouldReconnect && !isReconnecting) {
                isReconnecting = true;
                // Wait 3 seconds before reconnecting to avoid rapid loops
                setTimeout(() => {
                    isReconnecting = false;
                    wasi_startBot();
                }, 3000);
            }
        } else if (connection === 'open') {
            isReconnecting = false;
            isConnected = true;
            currentQR = null;
            console.log('Wasi Bot: Connected successfully!');
        }
    });


    wasi_sock.ev.on('creds.update', saveCreds);

    // Group Participants Update (Welcome/Goodbye)
    wasi_sock.ev.on('group-participants.update', async (update) => {
        const { handleGroupParticipantsUpdate } = require('./wasilib/groupevents');
        await handleGroupParticipantsUpdate(wasi_sock, update, config);
    });

    // Setup message handling
    setupMessageHandler(wasi_sock);
}

// Pairing code connection function
async function wasi_startBotWithPairing(phone) {
    return new Promise(async (resolve, reject) => {
        try {
            const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
            if (!dbResult) {
                return reject(new Error('Database connection failed'));
            }
            isDbConnected = !!dbResult;

            let codeResolved = false;
            let retryCount = 0;
            const maxRetries = 3;
            let timeout;

            // Timer to reject if pairing takes too long
            timeout = setTimeout(() => {
                if (!codeResolved) {
                    reject(new Error('Pairing code timeout - please try again'));
                }
            }, 120000); // 2 minute timeout

            const startSocket = async () => {
                try {
                    const { wasi_sock, saveCreds } = await wasi_connectSession(true);
                    currentSock = wasi_sock;

                    // Function to request pairing code with retry
                    const tryRequestCode = async () => {
                        if (codeResolved || retryCount >= maxRetries) return;

                        retryCount++;
                        try {
                            console.log(`Wasi Bot: Requesting pairing code (attempt ${retryCount})...`);

                            // Wait for socket to be stable
                            await new Promise(r => setTimeout(r, 3000));

                            if (!wasi_sock.authState.creds.registered) {
                                const code = await wasi_sock.requestPairingCode(phone);
                                codeResolved = true;
                                clearTimeout(timeout);
                                console.log(`Wasi Bot: Pairing code for ${phone}: ${code}`);
                                resolve(code);
                            }
                        } catch (err) {
                            console.error(`Pairing attempt ${retryCount} failed:`, err.message);
                            if (retryCount < maxRetries && !codeResolved) {
                                console.log('Retrying in 2 seconds...');
                                setTimeout(tryRequestCode, 2000);
                            }
                        }
                    };

                    wasi_sock.ev.on('connection.update', async (update) => {
                        const { connection, lastDisconnect, qr } = update;

                        if (qr) {
                            currentQR = qr;
                            isConnected = false;

                            // Start pairing code request when QR is available
                            if (!codeResolved && retryCount === 0) {
                                tryRequestCode();
                            }
                        }

                        if (connection === 'close') {
                            isConnected = false;
                            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                                lastDisconnect.error.output.statusCode : 500;

                            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                            console.log(`Wasi Bot: Pairing connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);

                            if (shouldReconnect) {
                                setTimeout(startSocket, 3000);
                            }
                        } else if (connection === 'open') {
                            isConnected = true;
                            currentQR = null;
                            codeResolved = true;
                            if (timeout) clearTimeout(timeout);
                            console.log('Wasi Bot: Connected via pairing code!');
                            setupMessageHandler(wasi_sock);
                        }
                    });

                    wasi_sock.ev.on('creds.update', saveCreds);
                } catch (e) {
                    console.error('Error starting pairing socket:', e);
                    // If initial connection fails, we might want to reject or retry
                }
            };

            startSocket();

        } catch (e) {
            reject(e);
        }
    });
}

// Separate message handler setup
// Separate message handler setup
// Separate message handler setup
function setupMessageHandler(wasi_sock) {
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        // Check for message age (prevent processing old messages)
        const messageTimestamp = wasi_msg.messageTimestamp;
        if (messageTimestamp) {
            const messageTime = typeof messageTimestamp === 'number' ? messageTimestamp : messageTimestamp.low;
            const currentTime = Math.floor(Date.now() / 1000);
            const timeDiff = currentTime - messageTime;

            // If message is older than 30 seconds, ignore it
            if (timeDiff > 30) {
                return;
            }
        }

        const wasi_sender = wasi_msg.key.remoteJid;

        // Normalize message content
        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption || "";

        // ANTI-BOT CHECK
        if (wasi_sender.endsWith('@g.us')) {
            const { handleAntiBot } = require('./wasilib/antibot');
            // We don't pass metadata here to save resources; the function will fetch it if detection triggers.
            // Best to await to ensure we punish before replying to a command if it WAS a command.
            await handleAntiBot(wasi_sock, wasi_msg, true, wasi_msg.key.participant);
        }

        // Auto Status Seen Feature
        if (wasi_sender === 'status@broadcast') {
            try {
                const statusOwner = wasi_msg.key.participant;
                const { wasi_getUserAutoStatus } = require('./wasilib/database');

                // Check if status owner has enabled auto status in database
                const userSettings = await wasi_getUserAutoStatus(statusOwner);
                const shouldAutoView = userSettings?.autoStatusSeen || config.autoStatusSeen;

                if (!shouldAutoView) return;

                // Mark status as read
                await wasi_sock.readMessages([wasi_msg.key]);
                console.log(`Auto viewed status from: ${statusOwner}`);

                // React with heart (check user settings first, then global config)
                const shouldReact = userSettings?.autoStatusReact ?? config.autoStatusReact;
                if (shouldReact) {
                    await wasi_sock.sendMessage(wasi_sender, {
                        react: { text: '❤️', key: wasi_msg.key }
                    }, { statusJidList: [statusOwner] });
                }

                // Send message to user (check user settings first, then global config)
                const shouldMessage = userSettings?.autoStatusMessage ?? config.autoStatusMessage;
                if (shouldMessage) {
                    await wasi_sock.sendMessage(statusOwner, {
                        text: `👁️ Your status has been seen by *${config.botName}*!`
                    });
                }
            } catch (e) {
                console.error('Auto status error:', e.message);
            }
            return;
        }




        // Auto Read Messages
        if (config.autoReadMessages && !wasi_msg.key.fromMe) {
            try {
                await wasi_sock.readMessages([wasi_msg.key]);
            } catch (e) { /* ignore */ }
        }

        // ---------------------------------------------------------------------
        // AUTO VIEW ONCE LOGIC
        // ---------------------------------------------------------------------
        const viewOnceMsg = wasi_msg.message.viewOnceMessage || wasi_msg.message.viewOnceMessageV2;
        if (viewOnceMsg) {
            try {
                const { wasi_getUserAutoStatus } = require('./wasilib/database');
                // Check if feature is enabled for the bot owner or the current chat context
                // logic: If I (owner) have enabled it, I want to see it.
                // Or if the *sender* enabled it? Usually "Auto VV" is a tool for the bot user to see incoming VVs.
                // So we check the setting for the bot's owner or "me".

                // For simplicity, we check if the user who SENT the message (wasi_sender) has it ON? No, that's weird.
                // We check if the bot has it ON. But the settings are keyed by JID.
                // Let's assume we check the generic config OR the "owner's" setting.
                // Beause `wasi_getUserAutoStatus` takes a JID, we check the bot's own JID or owner JID?
                // Let's check config.ownerNumber + '@s.whatsapp.net'
                const ownerJid = config.ownerNumber + '@s.whatsapp.net';
                const ownerSettings = await wasi_getUserAutoStatus(ownerJid);

                if (ownerSettings?.autoViewOnce) {
                    const content = viewOnceMsg.message.imageMessage || viewOnceMsg.message.videoMessage || viewOnceMsg.message.audioMessage;
                    let type = '';
                    if (viewOnceMsg.message.imageMessage) type = 'image';
                    else if (viewOnceMsg.message.videoMessage) type = 'video';
                    else if (viewOnceMsg.message.audioMessage) type = 'audio';

                    if (content && type) {
                        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                        const stream = await downloadContentFromMessage(content, type);
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        // Resend media to the chat (so the owner can see it)
                        if (type === 'image') {
                            await wasi_sock.sendMessage(wasi_sender, { image: buffer, caption: '🔓 Auto View Once detected' }, { quoted: wasi_msg });
                        } else if (type === 'video') {
                            await wasi_sock.sendMessage(wasi_sender, { video: buffer, caption: '🔓 Auto View Once detected' }, { quoted: wasi_msg });
                        } else if (type === 'audio') {
                            await wasi_sock.sendMessage(wasi_sender, { audio: buffer, mimetype: 'audio/mp4', ptt: false }, { quoted: wasi_msg });
                        }
                        console.log(`Auto View Once recovered from ${wasi_sender}`);
                    }
                }
            } catch (e) {
                console.error('Auto VV Error:', e);
            }
        }
        // ---------------------------------------------------------------------

        // ---------------------------------------------------------------------

        // ---------------------------------------------------------------------
        // AUTO REPLY LOGIC
        // ---------------------------------------------------------------------
        if (config.autoReplyEnabled && wasi_text) {
            const lowerContent = wasi_text.trim().toLowerCase();
            // Check local config replies
            if (config.autoReplies) {
                const match = config.autoReplies.find(r => r.trigger.toLowerCase() === lowerContent);
                if (match) {
                    await wasi_sock.sendMessage(wasi_sender, { text: match.reply }, { quoted: wasi_msg });
                    return; // Stop further processing if we replied (unless you want commands to also work?)
                    // Typically if it's a trigger, we don't treat it as a command.
                }
            }
        }
        // ---------------------------------------------------------------------

        if (wasi_text.trim().startsWith(config.prefix)) {
            const wasi_parts = wasi_text.trim().slice(config.prefix.length).trim().split(/\s+/);
            const wasi_cmd_input = wasi_parts[0].toLowerCase();
            const wasi_args = wasi_parts.slice(1).join(' ');

            if (wasi_plugins.has(wasi_cmd_input)) {
                // Check if command is enabled
                const isEnabled = await wasi_isCommandEnabled(wasi_sender, wasi_cmd_input);
                if (!isEnabled) {
                    console.log(`Command ${wasi_cmd_input} is disabled in ${wasi_sender}`);
                    return;
                }

                // Show presence based on user settings or global config
                const { wasi_getUserAutoStatus } = require('./wasilib/database');
                const userPresenceSettings = await wasi_getUserAutoStatus(wasi_sender);
                const shouldType = userPresenceSettings?.autoTyping ?? config.autoTyping;
                const shouldRecord = userPresenceSettings?.autoRecording ?? config.autoRecording;

                try {
                    if (shouldRecord) {
                        await wasi_sock.sendPresenceUpdate('recording', wasi_sender);
                    } else if (shouldType) {
                        await wasi_sock.sendPresenceUpdate('composing', wasi_sender);
                    }
                } catch (e) { /* ignore presence errors */ }

                console.log(`Executing plugin: ${wasi_cmd_input}`);
                const plugin = wasi_plugins.get(wasi_cmd_input);

                // Check if command is owner-only
                if (plugin.ownerOnly) {
                    const senderNumber = wasi_sender.replace('@s.whatsapp.net', '').replace('@lid', '');
                    const isOwner = senderNumber.includes(config.ownerNumber) || wasi_msg.key.fromMe;
                    if (!isOwner) {
                        return wasi_sock.sendMessage(wasi_sender, {
                            text: '❌ *Access Denied!*\n\nYou are not the owner. Only the bot owner can use this command.'
                        });
                    }
                }
                try {
                    const wasi_isGroup = wasi_sender.endsWith('@g.us');
                    await plugin.wasi_handler(wasi_sock, wasi_sender, {
                        wasi_plugins,
                        wasi_args: wasi_parts.slice(1), // Fix: wasi_args passed as array/string inconsistencies. In my plugins I used wasi_args.join(' ') for description, but .slice(1) gives an array.
                        // Wait, previous code: const wasi_args = wasi_parts.slice(1).join(' '); (Line 519)
                        // So wasi_args is a STRING. 
                        // But my 'goodbye.js' checks `wasi_args[0]`. Accessing [0] on a string 'on' gives 'o'. That's WRONG if I expected an array. 
                        // Let's fix wasi_args passing and wasi_isGroup.

                        wasi_args: wasi_parts.slice(1), // Pass ARRAY for args access like args[0]
                        wasi_isGroup,
                        wasi_msg,
                        wasi_text
                    });
                } catch (e) {
                    console.error('Error in plugin:', e);
                }

                // Stop presence after execution
                try {
                    await wasi_sock.sendPresenceUpdate('paused', wasi_sender);
                } catch (e) { /* ignore presence errors */ }
            } else {
                console.log('Command not found in plugins');
            }
        }
    });
}

wasi_loadPlugins();
wasi_startServer();
wasi_startBot();
