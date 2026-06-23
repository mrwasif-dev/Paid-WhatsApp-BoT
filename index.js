require('dotenv').config();
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const QRCode = require('qrcode');
const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;
const sessions = new Map();

// ============================================================
// SEND BUTTON MESSAGE - TEST
// ============================================================

async function sendButtonMessage(sock, to) {
    try {
        // WhatsApp Business Style Template Buttons
        const message = {
            text: '🛍️ *Welcome to Test Store!*\n\n👇 Choose an option:',
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
        console.log('✅ Test buttons sent!');
        
    } catch (error) {
        console.error('Button error:', error);
        
        // Fallback: Simple text
        await sock.sendMessage(to, { 
            text: '🛍️ *Welcome!*\n\nType:\n1. products\n2. cart\n3. orders\n4. categories' 
        });
    }
}

// ============================================================
// START SESSION
// ============================================================

async function startSession(sessionId) {
    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null
    };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            console.log('📱 QR Code generated!');
            console.log('Scan QR with WhatsApp to connect');
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            console.log(`Session closed, reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
            } else {
                console.log('Session logged out.');
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log('✅ Connected to WhatsApp!');
            console.log('🎯 Bot is ready!');
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // MESSAGE HANDLER - TEST
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
                    response = '🛍️ *Products List*\n\n1. iPhone 15 Pro - Rs.350,000\n2. Samsung S24 - Rs.280,000\n3. AirPods Pro - Rs.45,000';
                    break;
                case 'cart':
                    response = '🛒 *Your Cart*\n\nYour cart is empty!';
                    break;
                case 'orders':
                    response = '📦 *Your Orders*\n\nNo orders yet!';
                    break;
                case 'categories':
                    response = '📂 *Categories*\n\n• Electronics\n• Accessories\n• Clothing\n• Books';
                    break;
                default:
                    response = '❌ Unknown option';
            }
            
            await sendButtonMessage(wasi_sock, from);
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Handle text commands
        if (text) {
            console.log(`Text: ${text} from ${from}`);
            
            if (['hi', 'hello', 'start'].includes(text)) {
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
    const sessionId = req.query.sessionId || 'test_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;

    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) {}
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        activeSessions: Array.from(sessions.keys())
    });
});

wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

wasi_app.get('/', (req, res) => {
    res.send(`
        <h1>🛍️ Test Bot</h1>
        <p>Status: ${sessions.get('test_session')?.isConnected ? '🟢 Connected' : '🔴 Disconnected'}</p>
        <p>Check /api/status for QR code</p>
    `);
});

// ============================================================
// SERVER START
// ============================================================

function startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📌 Status: http://localhost:${wasi_port}/api/status`);
        console.log(`📌 QR Code: Check /api/status in browser`);
    });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('🛍️ Starting Test Bot...');
    
    const sessionId = 'test_session';
    await startSession(sessionId);
    
    startServer();
}

main();
