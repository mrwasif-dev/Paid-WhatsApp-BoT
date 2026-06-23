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
// SEND BUTTON MESSAGE - CORRECT WAY
// ============================================================

async function sendButtonMessage(sock, to) {
    try {
        // یہ Baileys کا صحیح طریقہ ہے بٹن بھیجنے کا
        const buttons = [
            {
                buttonId: 'products',
                buttonText: { displayText: '🛍️ Products' },
                type: 1
            },
            {
                buttonId: 'cart',
                buttonText: { displayText: '🛒 My Cart' },
                type: 1
            },
            {
                buttonId: 'orders',
                buttonText: { displayText: '📦 My Orders' },
                type: 1
            },
            {
                buttonId: 'categories',
                buttonText: { displayText: '📂 Categories' },
                type: 1
            }
        ];

        const buttonMessage = {
            text: '🛍️ *Welcome to Our Store!*\n\n👇 *Tap a button below:*',
            footer: 'Store Bot',
            buttons: buttons,
            headerType: 1
        };

        await sock.sendMessage(to, buttonMessage);
        console.log('✅ Buttons sent successfully!');
        
    } catch (error) {
        console.error('Button error:', error);
        
        // Fallback - simple message
        await sock.sendMessage(to, { 
            text: '🛍️ *Welcome to Our Store!*\n\n' +
                  'Type these commands:\n' +
                  '1️⃣ products - View Products\n' +
                  '2️⃣ cart - View Cart\n' +
                  '3️⃣ orders - My Orders\n' +
                  '4️⃣ categories - Categories' 
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

        // Check button response - CORRECT WAY
        if (wasi_msg.message?.buttonsResponseMessage?.selectedButtonId) {
            buttonId = wasi_msg.message.buttonsResponseMessage.selectedButtonId;
        } else if (wasi_msg.message?.templateButtonReplyMessage?.selectedId) {
            buttonId = wasi_msg.message.templateButtonReplyMessage.selectedId;
        } else if (wasi_msg.message?.conversation) {
            text = wasi_msg.message.conversation.trim().toLowerCase();
        } else if (wasi_msg.message?.extendedTextMessage?.text) {
            text = wasi_msg.message.extendedTextMessage.text.trim().toLowerCase();
        }

        // ============================================================
        // HANDLE BUTTON CLICKS
        // ============================================================
        
        if (buttonId) {
            console.log(`🔘 Button clicked: ${buttonId} from ${from}`);
            
            let response = '';
            let showButtons = true;
            
            switch(buttonId) {
                case 'products':
                    response = '🛍️ *Products List*\n\n' +
                              '📱 *iPhone 15 Pro*\n' +
                              '💰 Rs. 350,000\n' +
                              '📦 Stock: 10\n\n' +
                              '📱 *Samsung Galaxy S24*\n' +
                              '💰 Rs. 280,000\n' +
                              '📦 Stock: 15\n\n' +
                              '🎧 *AirPods Pro*\n' +
                              '💰 Rs. 45,000\n' +
                              '📦 Stock: 8\n\n' +
                              '⌚ *Smart Watch Series 9*\n' +
                              '💰 Rs. 65,000\n' +
                              '📦 Stock: 5\n\n' +
                              '👇 *Tap a button to continue:*';
                    break;
                    
                case 'cart':
                    response = '🛒 *Your Cart*\n\n' +
                              'Your cart is empty!\n\n' +
                              '🛍️ Browse products and add to cart.\n\n' +
                              '👇 *Tap a button to continue:*';
                    break;
                    
                case 'orders':
                    response = '📦 *My Orders*\n\n' +
                              'No orders yet!\n\n' +
                              '🛍️ Place your first order today.\n\n' +
                              '👇 *Tap a button to continue:*';
                    break;
                    
                case 'categories':
                    response = '📂 *Categories*\n\n' +
                              '🛍️ Available Categories:\n\n' +
                              '• Electronics 📱\n' +
                              '• Accessories 🎧\n' +
                              '• Clothing 👕\n' +
                              '• Books 📚\n' +
                              '• Other 📦\n\n' +
                              '👇 *Tap a button to continue:*';
                    break;
                    
                default:
                    response = '❌ Unknown option.\n\n👇 *Tap a button below:*';
            }
            
            // Send response with buttons
            await wasi_sock.sendMessage(from, { text: response });
            
            // Show main menu buttons again
            await sendButtonMessage(wasi_sock, from);
            return;
        }

        // ============================================================
        // HANDLE TEXT COMMANDS
        // ============================================================
        
        if (text) {
            console.log(`💬 Text: ${text} from ${from}`);
            
            // Greetings
            if (['hi', 'hello', 'start', 'menu', 'hey'].includes(text)) {
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            // Product commands
            if (text === 'products' || text === '1') {
                await wasi_sock.sendMessage(from, { 
                    text: '🛍️ *Products List*\n\n' +
                          '📱 iPhone 15 Pro - Rs.350,000\n' +
                          '📱 Samsung S24 - Rs.280,000\n' +
                          '🎧 AirPods Pro - Rs.45,000\n' +
                          '⌚ Smart Watch - Rs.65,000' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            // Cart command
            if (text === 'cart' || text === '2') {
                await wasi_sock.sendMessage(from, { 
                    text: '🛒 *Your Cart*\n\nYour cart is empty!' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            // Orders command
            if (text === 'orders' || text === '3') {
                await wasi_sock.sendMessage(from, { 
                    text: '📦 *My Orders*\n\nNo orders yet!' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
            
            // Categories command
            if (text === 'categories' || text === '4') {
                await wasi_sock.sendMessage(from, { 
                    text: '📂 *Categories*\n\n• Electronics 📱\n• Accessories 🎧\n• Clothing 👕\n• Books 📚' 
                });
                await sendButtonMessage(wasi_sock, from);
                return;
            }
        }

        // Default - send main menu
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
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
                .container { background: white; padding: 40px; border-radius: 16px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; }
                h1 { color: #1a1a2e; margin-bottom: 10px; font-size: 28px; }
                .subtitle { color: #636e72; margin-bottom: 25px; font-size: 14px; }
                .status { display: inline-block; padding: 8px 24px; border-radius: 20px; font-weight: 600; margin: 10px 0 20px; }
                .online { background: #d4edda; color: #155724; }
                .offline { background: #f8d7da; color: #721c24; }
                .qr-box { background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 15px 0; }
                .qr-box a { color: #25D366; text-decoration: none; font-weight: 600; }
                .btn-group { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin: 15px 0; }
                .btn { display: inline-block; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; transition: 0.3s; }
                .btn:hover { background: #1da851; }
                .btn-secondary { background: #6c5ce7; }
                .btn-secondary:hover { background: #5f3dc4; }
                .footer { margin-top: 25px; color: #b2bec3; font-size: 12px; }
                .session-id { background: #f1f2f6; padding: 4px 12px; border-radius: 4px; font-size: 12px; color: #636e72; display: inline-block; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛍️ Store Bot</h1>
                <p class="subtitle">WhatsApp Business Store</p>
                <div class="status ${connected ? 'online' : 'offline'}">
                    ${connected ? '✅ Connected' : '⏳ Waiting for connection...'}
                </div>
                ${!connected ? `
                <div class="qr-box">
                    <p style="margin-bottom: 10px;">📱 Scan QR to connect:</p>
                    <a href="/api/status" target="_blank">Click here to get QR Code</a>
                </div>
                ` : `
                <div style="background: #d4edda; padding: 15px; border-radius: 8px; margin: 10px 0;">
                    ✅ Bot is online! Send "hi" on WhatsApp to start.
                </div>
                `}
                <div class="btn-group">
                    <a href="/api/status" class="btn">📱 QR Code</a>
                    <a href="/ping" class="btn btn-secondary">🏓 Ping</a>
                </div>
                <div class="session-id">Session: ${sessionId}</div>
                <div class="footer">Bot is running on port ${wasi_port}</div>
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
// API: HEALTH
// ============================================================

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size
    });
});

// ============================================================
// SERVER START
// ============================================================

function startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Server running on port ${wasi_port}`);
        console.log(`📌 Web: http://localhost:${wasi_port}`);
        console.log(`📌 Status: http://localhost:${wasi_port}/api/status`);
        console.log(`📌 QR: http://localhost:${wasi_port}/api/status`);
        console.log(`\n🔘 Bot Commands:`);
        console.log(`   Type: hi, hello, start, menu`);
        console.log(`   Or: products, cart, orders, categories`);
        console.log(`\n✅ Bot is ready! Scan QR and send "hi" on WhatsApp.`);
    });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('🛍️ Starting Store Bot...');
    console.log('===============================');
    
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
