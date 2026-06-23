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
const QRCode = require('qrcode');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// SEND BUTTON MESSAGE - WhatsApp Business Style
// ============================================================

async function sendButtonMessage(sock, to) {
    try {
        const message = {
            text: '🛍️ *Welcome to Store!*\n\n👇 Choose an option:',
            templateButtons: [
                {
                    index: 0,
                    quickReplyButton: {
                        displayText: '🛍️ Products',
                        id: 'products'
                    }
                },
                {
                    index: 1,
                    quickReplyButton: {
                        displayText: '🛒 Cart',
                        id: 'cart'
                    }
                },
                {
                    index: 2,
                    quickReplyButton: {
                        displayText: '📦 Orders',
                        id: 'orders'
                    }
                },
                {
                    index: 3,
                    quickReplyButton: {
                        displayText: '📂 Categories',
                        id: 'categories'
                    }
                }
            ]
        };
        
        await sock.sendMessage(to, message);
        console.log('✅ Buttons sent!');
        
    } catch (error) {
        console.error('Button error:', error);
        
        // Fallback
        await sock.sendMessage(to, { 
            text: '🛍️ *Welcome!*\n\nType:\n1. products\n2. cart\n3. orders\n4. categories' 
        });
    }
}

// ============================================================
// START SESSION
// ============================================================

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
            console.log(`📱 QR generated for session: ${sessionId}`);
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
            console.log('🎯 Bot is ready!');
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // MESSAGE HANDLER
    // ============================================================

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const from = wasi_msg.key.remoteJid;
        const isFromMe = wasi_msg.key.fromMe;

        if (isFromMe) return;

        let buttonId = null;
        let text = null;

        // Check button response
        if (wasi_msg.message?.buttonsResponseMessage?.selectedButtonId) {
            buttonId = wasi_msg.message.buttonsResponseMessage.selectedButtonId;
        } else if (wasi_msg.message?.templateButtonReplyMessage?.selectedId) {
            buttonId = wasi_msg.message.templateButtonReplyMessage.selectedId;
        } else if (wasi_msg.message?.conversation) {
            text = wasi_msg.message.conversation.trim().toLowerCase();
        } else if (wasi_msg.message?.extendedTextMessage?.text) {
            text = wasi_msg.message.extendedTextMessage.text.trim().toLowerCase();
        }

        // Handle button clicks
        if (buttonId) {
            console.log(`Button clicked: ${buttonId} from ${from}`);
            
            let response = '';
            switch(buttonId) {
                case 'products':
                    response = '🛍️ *Products List*\n\n📱 iPhone 15 Pro - Rs.350,000\n📱 Samsung S24 - Rs.280,000\n🎧 AirPods Pro - Rs.45,000\n⌚ Smart Watch - Rs.65,000';
                    break;
                case 'cart':
                    response = '🛒 *Your Cart*\n\nYour cart is empty!\n\nAdd products to start shopping.';
                    break;
                case 'orders':
                    response = '📦 *Your Orders*\n\nNo orders yet!\n\nPlace your first order today.';
                    break;
                case 'categories':
                    response = '📂 *Categories*\n\n• Electronics 📱\n• Accessories 🎧\n• Clothing 👕\n• Books 📚';
                    break;
                default:
                    response = '❌ Unknown option. Please try again.';
            }
            
            await wasi_sock.sendMessage(from, { text: response });
            await sendButtonMessage(wasi_sock, from);
            return;
        }

        // Handle text commands
        if (text) {
            console.log(`Text: ${text} from ${from}`);
            
            if (['hi', 'hello', 'start', 'menu'].includes(text)) {
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            // Handle text commands
            if (text === 'products' || text === '1') {
                await wasi_sock.sendMessage(from, { 
                    text: '🛍️ *Products List*\n\n📱 iPhone 15 Pro - Rs.350,000\n📱 Samsung S24 - Rs.280,000\n🎧 AirPods Pro - Rs.45,000\n⌚ Smart Watch - Rs.65,000' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            if (text === 'cart' || text === '2') {
                await wasi_sock.sendMessage(from, { 
                    text: '🛒 *Your Cart*\n\nYour cart is empty!' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            if (text === 'orders' || text === '3') {
                await wasi_sock.sendMessage(from, { 
                    text: '📦 *Your Orders*\n\nNo orders yet!' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            if (text === 'categories' || text === '4') {
                await wasi_sock.sendMessage(from, { 
                    text: '📂 *Categories*\n\n• Electronics 📱\n• Accessories 🎧\n• Clothing 👕\n• Books 📚' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
        }

        // Default - send button message
        await sendButtonMessage(wasi_sock, from);
    });
}

// ============================================================
// API ROUTES
// ============================================================

wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'test_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = false;

    if (config.mongoDbUrl) {
        try {
            dbConnected = true;
        } catch (e) {
            dbConnected = false;
        }
    }

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
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        activeSessions: Array.from(sessions.keys()),
        timestamp: new Date().toISOString()
    });
});

wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

wasi_app.get('/', (req, res) => {
    const sessionId = config.sessionId || 'test_session';
    const session = sessions.get(sessionId);
    const connected = session?.isConnected || false;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>🛍️ Test Bot</title>
            <style>
                body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .status { font-size: 20px; padding: 10px; border-radius: 5px; }
                .online { color: green; }
                .offline { color: red; }
                .qr { margin: 20px 0; }
                .btn { display: inline-block; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; margin: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛍️ Test Bot</h1>
                <div class="status ${connected ? 'online' : 'offline'}">
                    ${connected ? '✅ Connected' : '❌ Disconnected'}
                </div>
                <div class="qr">
                    <p>Scan QR to connect:</p>
                    <a href="/api/status" target="_blank">📱 Get QR Code</a>
                </div>
                <div>
                    <a href="/api/status" class="btn">Status</a>
                    <a href="/ping" class="btn">Ping</a>
                </div>
                <p style="color: #666; font-size: 12px; margin-top: 20px;">Session: ${sessionId}</p>
            </div>
        </body>
        </html>
    `);
});

// ============================================================
// API: RESTART
// ============================================================

wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        for (const [sessionId, session] of sessions) {
            if (session.sock) {
                try {
                    session.sock.end(undefined);
                } catch (e) {
                    console.error(`Error ending session ${sessionId}:`, e);
                }
            }
        }
        sessions.clear();
        setTimeout(() => {
            main().catch(err => console.error('Restart error:', err));
        }, 1000);
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// API: LOGOUT
// ============================================================

wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'test_session';
        const session = sessions.get(sessionId);
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// SERVER START
// ============================================================

function startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📌 Web: http://localhost:${wasi_port}`);
        console.log(`📌 Status: http://localhost:${wasi_port}/api/status`);
        console.log(`📌 QR: Check /api/status in browser`);
        console.log(`\n🔘 Bot Commands:`);
        console.log(`   Type: hi, hello, start, menu`);
        console.log(`   Or type: products, cart, orders, categories`);
    });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('🛍️ Starting Test Bot...');
    
    // 1. Connect DB if configured
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    // 2. Start session
    const sessionId = config.sessionId || 'test_session';
    await startSession(sessionId);

    // 3. Start server
    startServer();
}

main();
