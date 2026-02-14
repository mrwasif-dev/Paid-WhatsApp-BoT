require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const pino = require('pino');
const http = require('http');
const socketIo = require('socket.io');
const QRCode = require('qrcode');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

// -----------------------------------------------------------------------------
// CONFIG FILE PATH
// -----------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, 'botConfig.json');

// Default config
let botConfig = {
    sourceJids: [],
    targetJids: [],
    oldTextRegex: [],
    newText: ''
};

// Load config from file if exists
if (fs.existsSync(CONFIG_FILE)) {
    try {
        botConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        console.log('✅ Config loaded from botConfig.json');
    } catch (e) {
        console.error('❌ Error loading config:', e);
    }
}

// Environment se default config load karo
if (process.env.SOURCE_JIDS) {
    botConfig.sourceJids = process.env.SOURCE_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.TARGET_JIDS) {
    botConfig.targetJids = process.env.TARGET_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.OLD_TEXT_REGEX) {
    botConfig.oldTextRegex = process.env.OLD_TEXT_REGEX.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.NEW_TEXT) {
    botConfig.newText = process.env.NEW_TEXT;
}

// Compile regex patterns
let compiledRegexes = [];
try {
    compiledRegexes = botConfig.oldTextRegex.map(pattern => new RegExp(pattern, 'gu'));
} catch (e) {
    console.error('❌ Regex compilation error:', e);
}

// -----------------------------------------------------------------------------
// EXPRESS & SOCKET.IO SETUP
// -----------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Store active socket connection
let activeSock = null;
let connectionStatus = 'disconnected';
let qrCodeData = null;
let dbConnected = false;
let currentPairingCode = null;

// -----------------------------------------------------------------------------
// SOCKET.IO CONNECTION HANDLER
// -----------------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log('📱 Dashboard client connected');
    
    socket.emit('initial_status', {
        status: connectionStatus,
        qr: qrCodeData,
        databaseConnected: dbConnected,
        user: activeSock?.user?.id || null,
        pairingCode: currentPairingCode
    });

    socket.on('request_qr', () => {
        if (connectionStatus !== 'connected') {
            startConnection('qr');
        }
    });

    socket.on('request_pairing', (data) => {
        if (data.phoneNumber && connectionStatus !== 'connected') {
            startConnection('pairing', data.phoneNumber);
        }
    });

    socket.on('disconnect_bot', async () => {
        if (activeSock) {
            try {
                activeSock.end();
                activeSock = null;
                connectionStatus = 'disconnected';
                qrCodeData = null;
                currentPairingCode = null;
                io.emit('status_update', { 
                    status: 'disconnected',
                    message: 'Bot disconnected'
                });
            } catch (error) {
                console.error('Disconnect error:', error);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('📱 Dashboard client disconnected');
    });
});

// -----------------------------------------------------------------------------
// API ENDPOINTS
// -----------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
    res.json({
        sourceJids: botConfig.sourceJids,
        targetJids: botConfig.targetJids,
        oldTextRegex: botConfig.oldTextRegex,
        newText: botConfig.newText
    });
});

app.post('/api/config', (req, res) => {
    try {
        const { sourceJids, targetJids, oldTextRegex, newText } = req.body;
        
        botConfig = {
            sourceJids: sourceJids || [],
            targetJids: targetJids || [],
            oldTextRegex: oldTextRegex || [],
            newText: newText || ''
        };
        
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
        
        try {
            compiledRegexes = botConfig.oldTextRegex.map(pattern => new RegExp(pattern, 'gu'));
        } catch (e) {
            console.error('❌ Regex compilation error:', e);
        }
        
        console.log('✅ Config saved:', botConfig);
        res.json({ success: true, message: 'Config saved' });
    } catch (error) {
        console.error('❌ Config save error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        connected: connectionStatus === 'connected',
        databaseConnected: dbConnected,
        qr: qrCodeData,
        user: activeSock?.user?.id || null,
        pairingCode: currentPairingCode
    });
});

app.post('/api/connect/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ success: false, message: 'Already connected' });
    }
    startConnection('qr');
    res.json({ success: true, message: 'Starting QR connection' });
});

app.post('/api/connect/pairing', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.json({ success: false, message: 'Phone number required' });
    }
    if (connectionStatus === 'connected') {
        return res.json({ success: false, message: 'Already connected' });
    }
    startConnection('pairing', phoneNumber);
    res.json({ success: true, message: 'Starting pairing connection' });
});

app.post('/api/disconnect', async (req, res) => {
    if (activeSock) {
        try {
            activeSock.end();
            activeSock = null;
            connectionStatus = 'disconnected';
            qrCodeData = null;
            currentPairingCode = null;
            io.emit('status_update', { 
                status: 'disconnected',
                message: 'Bot disconnected' 
            });
            res.json({ success: true, message: 'Disconnected' });
        } catch (error) {
            res.json({ success: false, message: error.message });
        }
    } else {
        res.json({ success: false, message: 'Not connected' });
    }
});

// -----------------------------------------------------------------------------
// WHATSAPP CONNECTION FUNCTION
// -----------------------------------------------------------------------------
async function startConnection(method = 'qr', phoneNumber = null) {
    try {
        connectionStatus = 'connecting';
        qrCodeData = null;
        currentPairingCode = null;
        
        io.emit('status_update', { 
            status: 'connecting',
            message: 'Connecting to WhatsApp...' 
        });
        
        console.log('🔄 Connecting to WhatsApp...');

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        activeSock = sock;

        // Handle pairing code if requested
        if (method === 'pairing' && phoneNumber && !sock.authState.creds.registered) {
            try {
                console.log(`📱 Requesting pairing code for ${phoneNumber}...`);
                let code = await sock.requestPairingCode(phoneNumber);
                currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                io.emit('pairing_code', { code: currentPairingCode });
                console.log('🔐 Pairing code:', currentPairingCode);
            } catch (error) {
                console.error('❌ Pairing code error:', error);
                io.emit('error', { message: 'Failed to generate pairing code' });
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && method === 'qr') {
                try {
                    qrCodeData = await QRCode.toDataURL(qr);
                    io.emit('qr_update', { qr: qrCodeData });
                    console.log('📱 QR code generated');
                } catch (err) {
                    console.error('QR generation error:', err);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = 
                    (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                qrCodeData = null;
                currentPairingCode = null;
                
                io.emit('status_update', { 
                    status: 'disconnected',
                    message: lastDisconnect?.error?.message || 'Connection closed'
                });
                
                console.log('❌ Connection closed:', lastDisconnect?.error?.message);
                
                if (shouldReconnect) {
                    console.log('🔄 Auto-reconnecting...');
                } else {
                    activeSock = null;
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCodeData = null;
                currentPairingCode = null;
                
                io.emit('status_update', { 
                    status: 'connected',
                    message: 'WhatsApp connected!',
                    user: sock.user?.id 
                });
                
                console.log('✅ WhatsApp connected:', sock.user?.id);
                
                if (typeof wasi_connectSession === 'function') {
                    wasi_connectSession(sock);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Message handler - آپ کا اوریجنل فلو بالکل ویسے ہی ہے
        sock.ev.on('messages.upsert', async (messageUpsert) => {
            try {
                const messages = messageUpsert.messages;
                if (!messages || messages.length === 0) return;

                for (const msg of messages) {
                    if (!msg.message) continue;

                    const from = msg.key.remoteJid;
                    const sender = msg.key.participant || from;
                    const messageType = Object.keys(msg.message)[0];
                    
                    if (from === 'status@broadcast') continue;

                    let messageText = '';
                    if (msg.message.conversation) {
                        messageText = msg.message.conversation;
                    } else if (msg.message.extendedTextMessage?.text) {
                        messageText = msg.message.extendedTextMessage.text;
                    } else if (msg.message.imageMessage?.caption) {
                        messageText = msg.message.imageMessage.caption;
                    } else if (msg.message.videoMessage?.caption) {
                        messageText = msg.message.videoMessage.caption;
                    }

                    if (!messageText) continue;

                    const isFromSource = botConfig.sourceJids.some(jid => 
                        from.includes(jid) || from === jid
                    );

                    if (!isFromSource) continue;

                    let shouldReplace = false;
                    for (const regex of compiledRegexes) {
                        if (regex.test(messageText)) {
                            shouldReplace = true;
                            break;
                        }
                    }

                    if (!shouldReplace) continue;

                    for (const targetJid of botConfig.targetJids) {
                        try {
                            await sock.sendMessage(targetJid, {
                                text: botConfig.newText || messageText
                            });
                            console.log(`✅ Forwarded message from ${from} to ${targetJid}`);
                            io.emit('log', { 
                                type: 'success',
                                message: `Forwarded to ${targetJid}` 
                            });
                        } catch (sendError) {
                            console.error(`❌ Error sending to ${targetJid}:`, sendError);
                            io.emit('log', { 
                                type: 'error',
                                message: `Failed to send to ${targetJid}` 
                            });
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Message handler error:', error);
            }
        });

        return sock;
    } catch (error) {
        console.error('❌ Connection error:', error);
        connectionStatus = 'error';
        io.emit('status_update', { 
            status: 'error',
            message: error.message 
        });
    }
}

// -----------------------------------------------------------------------------
// DATABASE CONNECTION
// -----------------------------------------------------------------------------
async function connectDatabase() {
    try {
        if (typeof wasi_connectDatabase === 'function') {
            await wasi_connectDatabase();
            dbConnected = true;
            console.log('✅ Database connected');
        }
    } catch (error) {
        console.error('❌ Database error:', error);
        dbConnected = false;
    }
}

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Dashboard: http://localhost:${PORT}\n`);
    connectDatabase();
});

// -----------------------------------------------------------------------------
// CLEANUP
// -----------------------------------------------------------------------------
process.on('SIGINT', async () => {
    console.log('\n📴 Shutting down...');
    if (activeSock) {
        activeSock.end();
    }
    if (typeof wasi_clearSession === 'function') {
        await wasi_clearSession();
    }
    process.exit(0);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});
