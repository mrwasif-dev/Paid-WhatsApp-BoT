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

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

// -----------------------------------------------------------------------------
// DEFAULT CONFIG FROM ENV (GLOBAL DEFAULTS)
// -----------------------------------------------------------------------------
let DEFAULT_SOURCE_JIDS = [];
let DEFAULT_TARGET_JIDS = [];
let DEFAULT_OLD_TEXT_REGEX = [];
let DEFAULT_NEW_TEXT = '';

// Environment se default config load karo
if (process.env.SOURCE_JIDS) {
    DEFAULT_SOURCE_JIDS = process.env.SOURCE_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.TARGET_JIDS) {
    DEFAULT_TARGET_JIDS = process.env.TARGET_JIDS.split(',').map(s => s.trim()).filter(s => s);
}
if (process.env.OLD_TEXT_REGEX) {
    DEFAULT_OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error('Invalid regex pattern:', pattern);
            return null;
        }
    }).filter(p => p !== null);
}
if (process.env.NEW_TEXT) {
    DEFAULT_NEW_TEXT = process.env.NEW_TEXT;
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
app.use(express.static('public'));

// Store active socket connection
let activeSock = null;
let connectionStatus = 'disconnected';
let qrCode = null;
let pairingCode = null;

// -----------------------------------------------------------------------------
// SOCKET.IO CONNECTION HANDLER
// -----------------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log('Client connected to dashboard');
    
    // Send current status to newly connected client
    socket.emit('status', { 
        status: connectionStatus,
        qr: qrCode,
        pairingCode: pairingCode,
        message: connectionStatus === 'connected' ? 'Bot is running' : 'Disconnected'
    });

    // Handle QR code request
    socket.on('request_qr', () => {
        if (connectionStatus !== 'connected') {
            startConnection('qr');
        }
    });

    // Handle pairing code request
    socket.on('request_pairing', (data) => {
        if (data.phoneNumber && connectionStatus !== 'connected') {
            startConnection('pairing', data.phoneNumber);
        }
    });

    // Handle disconnect request
    socket.on('disconnect_bot', async () => {
        if (activeSock) {
            try {
                activeSock.end();
                activeSock = null;
                connectionStatus = 'disconnected';
                qrCode = null;
                pairingCode = null;
                io.emit('status', { 
                    status: 'disconnected',
                    message: 'Bot disconnected'
                });
            } catch (error) {
                console.error('Disconnect error:', error);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected from dashboard');
    });
});

// -----------------------------------------------------------------------------
// MAIN WHATSAPP CONNECTION FUNCTION
// -----------------------------------------------------------------------------
async function startConnection(method = 'qr', phoneNumber = null) {
    try {
        connectionStatus = 'connecting';
        io.emit('status', { 
            status: 'connecting',
            message: 'Connecting to WhatsApp...' 
        });

        // Get authentication state
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        // Fetch latest version
        const { version } = await fetchLatestBaileysVersion();

        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // Disable terminal QR
            logger: pino({ level: 'silent' }),
            browser: ['Chrome', 'Linux', '10.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            qrTimeout: 60000 // QR timeout in ms
        });

        activeSock = sock;

        // Handle pairing code if method is pairing
        if (method === 'pairing' && phoneNumber && !sock.authState.creds.registered) {
            try {
                pairingCode = await sock.requestPairingCode(phoneNumber);
                // Format pairing code
                pairingCode = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
                io.emit('pairing_code', { code: pairingCode });
                console.log(`Pairing code generated for ${phoneNumber}`);
            } catch (error) {
                console.error('Pairing code error:', error);
                io.emit('error', { message: 'Failed to generate pairing code' });
            }
        }

        // Connection update handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCode = qr;
                io.emit('qr', { qr: qrCode });
                console.log('QR code generated');
            }

            if (connection === 'close') {
                const shouldReconnect = 
                    (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                connectionStatus = 'disconnected';
                qrCode = null;
                pairingCode = null;
                
                io.emit('status', { 
                    status: 'disconnected',
                    message: 'Connection closed',
                    shouldReconnect 
                });
                
                console.log('Connection closed:', lastDisconnect?.error?.message);
                
                if (shouldReconnect && activeSock) {
                    console.log('Attempting to reconnect...');
                    // Auto reconnect logic here if needed
                } else {
                    activeSock = null;
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                pairingCode = null;
                
                io.emit('status', { 
                    status: 'connected',
                    message: 'WhatsApp connected successfully!',
                    user: sock.user?.id 
                });
                
                console.log('WhatsApp connected:', sock.user?.id);
                
                // Initialize session
                if (typeof wasi_connectSession === 'function') {
                    wasi_connectSession(sock);
                }
            }
        });

        // Credentials update handler
        sock.ev.on('creds.update', saveCreds);

        // Message handler
        sock.ev.on('messages.upsert', async (messageUpsert) => {
            try {
                const messages = messageUpsert.messages;
                if (!messages || messages.length === 0) return;

                for (const msg of messages) {
                    if (!msg.message) continue;

                    const from = msg.key.remoteJid;
                    
                    // Skip status messages
                    if (from === 'status@broadcast') continue;

                    // Get message text
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

                    // Check if message is from source JIDs
                    const isFromSource = DEFAULT_SOURCE_JIDS.some(jid => 
                        from.includes(jid) || from === jid
                    );

                    if (!isFromSource) continue;

                    // Check regex patterns
                    let shouldReplace = false;
                    for (const regex of DEFAULT_OLD_TEXT_REGEX) {
                        if (regex.test(messageText)) {
                            shouldReplace = true;
                            break;
                        }
                    }

                    if (!shouldReplace) continue;

                    // Send to target JIDs
                    for (const targetJid of DEFAULT_TARGET_JIDS) {
                        try {
                            await sock.sendMessage(targetJid, {
                                text: DEFAULT_NEW_TEXT || messageText
                            });
                            console.log(`✅ Forwarded message from ${from} to ${targetJid}`);
                            io.emit('log', { 
                                type: 'success',
                                message: `Forwarded message to ${targetJid}` 
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
        console.error('Connection error:', error);
        connectionStatus = 'error';
        io.emit('status', { 
            status: 'error',
            message: error.message 
        });
    }
}

// -----------------------------------------------------------------------------
// API ENDPOINTS
// -----------------------------------------------------------------------------

// Health check
app.get('/api/status', (req, res) => {
    res.json({ 
        status: connectionStatus,
        user: activeSock?.user?.id || null,
        timestamp: new Date().toISOString()
    });
});

// Connect with QR
app.post('/api/connect/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ success: false, message: 'Already connected' });
    }
    
    startConnection('qr');
    res.json({ success: true, message: 'Starting QR connection' });
});

// Connect with pairing code
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

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    if (activeSock) {
        try {
            activeSock.end();
            activeSock = null;
            connectionStatus = 'disconnected';
            qrCode = null;
            pairingCode = null;
            res.json({ success: true, message: 'Disconnected' });
        } catch (error) {
            res.json({ success: false, message: error.message });
        }
    } else {
        res.json({ success: false, message: 'Not connected' });
    }
});

// Get logs
app.get('/api/logs', (req, res) => {
    // You can implement log storage if needed
    res.json({ success: true, logs: [] });
});

// -----------------------------------------------------------------------------
// DATABASE CONNECTION
// -----------------------------------------------------------------------------
if (typeof wasi_connectDatabase === 'function') {
    wasi_connectDatabase().catch(console.error);
}

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
server.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log(`📱 Dashboard available at http://localhost:${PORT}`);
});

// -----------------------------------------------------------------------------
// CLEANUP ON EXIT
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
