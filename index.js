require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    makeWASocket,
    useMultiFileAuthState
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
// SEND INTERACTIVE MESSAGE - یہ ہر ورژن پر کام کرتا ہے
// ============================================================

async function sendInteractiveMessage(sock, to) {
    try {
        // یہ WhatsApp کا نیا interactive message طریقہ ہے
        const interactiveMessage = {
            text: '🛍️ *Welcome to Our Store!*\n\n' +
                  '📱 *WhatsApp Business Store*\n\n' +
                  '👇 *Choose an option:*',
            footer: '🛍️ Store Bot',
            interactive: {
                type: 'button',
                header: {
                    type: 'text',
                    text: '🛍️ Store Menu'
                },
                body: {
                    text: 'Select an option from below:'
                },
                footer: {
                    text: '🛍️ Store Bot'
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: 'products',
                                title: '🛍️ Products',
                                displayText: '🛍️ Products'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'cart',
                                title: '🛒 My Cart',
                                displayText: '🛒 My Cart'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'orders',
                                title: '📦 My Orders',
                                displayText: '📦 My Orders'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'categories',
                                title: '📂 Categories',
                                displayText: '📂 Categories'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'help',
                                title: '🆘 Help',
                                displayText: '🆘 Help'
                            }
                        }
                    ]
                }
            }
        };

        // Interactive message بھیجیں
        await sock.sendMessage(to, interactiveMessage);
        console.log('✅ Interactive message sent!');
        
    } catch (error) {
        console.error('Interactive error:', error);
        
        // Fallback - سادہ ٹیکسٹ
        await sendFallbackMessage(sock, to);
    }
}

// ============================================================
// SEND FALLBACK MESSAGE - جب کچھ نہ چلے
// ============================================================

async function sendFallbackMessage(sock, to) {
    try {
        const text = '🛍️ *Welcome to Our Store!*\n\n' +
                     '📱 *WhatsApp Business Store*\n\n' +
                     '📌 *Type these commands:*\n\n' +
                     '1️⃣ `products` - View Products\n' +
                     '2️⃣ `cart` - View Cart\n' +
                     '3️⃣ `orders` - My Orders\n' +
                     '4️⃣ `categories` - Categories\n' +
                     '5️⃣ `help` - Help & Info\n\n' +
                     '👆 *Type a command to continue*';

        await sock.sendMessage(to, { text: text });
        console.log('✅ Fallback message sent!');
        
    } catch (error) {
        console.error('Fallback error:', error);
    }
}

// ============================================================
// SEND PRODUCT LIST
// ============================================================

async function sendProductsInteractive(sock, to) {
    try {
        const interactiveMessage = {
            text: '🛍️ *Products List*\n\n' +
                  '💰 *Prices:*\n' +
                  '📱 iPhone 15 Pro - Rs.350,000\n' +
                  '📱 Samsung S24 - Rs.280,000\n' +
                  '🖤 Car Perfume - Rs.5,000\n' +
                  '🎧 AirPods Pro - Rs.45,000\n' +
                  '⌚ Smart Watch - Rs.65,000\n\n' +
                  '👇 *Select a product:*',
            footer: '🛍️ Store Bot',
            interactive: {
                type: 'button',
                header: {
                    type: 'text',
                    text: '🛍️ Products'
                },
                body: {
                    text: 'Tap a product to view details:'
                },
                footer: {
                    text: '🛍️ Store Bot'
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: 'view_p1',
                                title: '📱 iPhone 15 Pro',
                                displayText: '📱 iPhone 15 Pro'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'view_p2',
                                title: '📱 Samsung S24',
                                displayText: '📱 Samsung S24'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'view_p3',
                                title: '🖤 Car Perfume',
                                displayText: '🖤 Car Perfume'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'view_p4',
                                title: '🎧 AirPods Pro',
                                displayText: '🎧 AirPods Pro'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'view_p5',
                                title: '⌚ Smart Watch',
                                displayText: '⌚ Smart Watch'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'menu',
                                title: '🏠 Main Menu',
                                displayText: '🏠 Main Menu'
                            }
                        }
                    ]
                }
            }
        };

        await sock.sendMessage(to, interactiveMessage);
        
    } catch (error) {
        console.error('Products interactive error:', error);
        await sock.sendMessage(to, { 
            text: '🛍️ *Products*\n\n' +
                  '1️⃣ iPhone 15 Pro - Rs.350,000\n' +
                  '2️⃣ Samsung S24 - Rs.280,000\n' +
                  '3️⃣ Car Perfume - Rs.5,000\n' +
                  '4️⃣ AirPods Pro - Rs.45,000\n' +
                  '5️⃣ Smart Watch - Rs.65,000\n\n' +
                  'Type: view p1, view p2, view p3, view p4, view p5' 
        });
        await sendFallbackMessage(sock, to);
    }
}

// ============================================================
// SEND PRODUCT DETAIL
// ============================================================

async function sendProductDetail(sock, to, productId) {
    const products = {
        'p1': {
            name: 'iPhone 15 Pro Max',
            price: '350,000',
            category: 'Electronics',
            stock: 10,
            description: '📱 256GB Storage, A17 Chip, 48MP Camera'
        },
        'p2': {
            name: 'Samsung Galaxy S24 Ultra',
            price: '280,000',
            category: 'Electronics',
            stock: 15,
            description: '📱 512GB Storage, AI Features, S-Pen'
        },
        'p3': {
            name: 'Black Car Perfume',
            price: '5,000',
            category: 'Accessories',
            stock: 3,
            description: '🖤 Premium Long Lasting, 100ml'
        },
        'p4': {
            name: 'AirPods Pro',
            price: '45,000',
            category: 'Accessories',
            stock: 8,
            description: '🎧 Noise Cancellation, 24hr Battery'
        },
        'p5': {
            name: 'Smart Watch Series 9',
            price: '65,000',
            category: 'Electronics',
            stock: 5,
            description: '⌚ Health Monitor, GPS, Heart Rate'
        }
    };

    const product = products[productId];
    if (!product) {
        await sock.sendMessage(to, { text: '❌ Product not found!' });
        await sendInteractiveMessage(sock, to);
        return;
    }

    try {
        const interactiveMessage = {
            text: `🛍️ *${product.name}*\n\n` +
                  `📝 ${product.description}\n\n` +
                  `💰 *Price:* Rs. ${product.price}\n` +
                  `📂 *Category:* ${product.category}\n` +
                  `📦 *Stock:* ${product.stock} units\n\n` +
                  `👇 *What would you like to do?*`,
            footer: '🛍️ Store Bot',
            interactive: {
                type: 'button',
                header: {
                    type: 'text',
                    text: '📱 Product Detail'
                },
                body: {
                    text: 'Choose an action:'
                },
                footer: {
                    text: '🛍️ Store Bot'
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: `add_${productId}`,
                                title: '🛒 Add to Cart',
                                displayText: '🛒 Add to Cart'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'products',
                                title: '⬅️ Back',
                                displayText: '⬅️ Back'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: 'menu',
                                title: '🏠 Menu',
                                displayText: '🏠 Menu'
                            }
                        }
                    ]
                }
            }
        };

        await sock.sendMessage(to, interactiveMessage);
        
    } catch (error) {
        console.error('Product detail error:', error);
        await sock.sendMessage(to, { 
            text: `🛍️ *${product.name}*\n\n` +
                  `💰 Price: Rs. ${product.price}\n` +
                  `📦 Stock: ${product.stock}\n\n` +
                  `To add to cart: add ${productId}` 
        });
        await sendInteractiveMessage(sock, to);
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
            console.log(`📱 Send "hi" on WhatsApp to start`);
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

        // Interactive message response
        if (wasi_msg.message?.interactiveResponseMessage?.selectedReplyId) {
            buttonId = wasi_msg.message.interactiveResponseMessage.selectedReplyId;
        } else if (wasi_msg.message?.buttonsResponseMessage?.selectedButtonId) {
            buttonId = wasi_msg.message.buttonsResponseMessage.selectedButtonId;
        } else if (wasi_msg.message?.templateButtonReplyMessage?.selectedId) {
            buttonId = wasi_msg.message.templateButtonReplyMessage.selectedId;
        } else if (wasi_msg.message?.listResponseMessage?.singleSelectReply?.rowId) {
            buttonId = wasi_msg.message.listResponseMessage.singleSelectReply.rowId;
        } else if (wasi_msg.message?.conversation) {
            text = wasi_msg.message.conversation.trim().toLowerCase();
        } else if (wasi_msg.message?.extendedTextMessage?.text) {
            text = wasi_msg.message.extendedTextMessage.text.trim().toLowerCase();
        }

        // ============================================================
        // HANDLE BUTTON/INTERACTIVE CLICKS
        // ============================================================
        
        if (buttonId) {
            console.log(`🔘 Clicked: ${buttonId} from ${from}`);
            
            switch(buttonId) {
                case 'products':
                    await sendProductsInteractive(wasi_sock, from);
                    break;
                    
                case 'cart':
                    await sock.sendMessage(from, { 
                        text: '🛒 *Your Cart*\n\nYour cart is empty!\n\n🛍️ Browse products and add to cart.' 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                case 'orders':
                    await sock.sendMessage(from, { 
                        text: '📦 *My Orders*\n\nNo orders yet!\n\n🛍️ Place your first order today.' 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                case 'categories':
                    await sock.sendMessage(from, { 
                        text: '📂 *Categories*\n\n' +
                              '🛍️ Available Categories:\n\n' +
                              '• Electronics 📱\n' +
                              '• Accessories 🎧\n' +
                              '• Clothing 👕\n' +
                              '• Books 📚\n' +
                              '• Other 📦' 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                case 'help':
                    await sock.sendMessage(from, { 
                        text: '🆘 *Help*\n\n' +
                              '📖 *Commands:*\n' +
                              '• products - View products\n' +
                              '• cart - View cart\n' +
                              '• orders - View orders\n' +
                              '• categories - Categories\n' +
                              '• help - This help\n\n' +
                              '🛍️ *Happy Shopping!*' 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                case 'menu':
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                case 'view_p1':
                case 'view_p2':
                case 'view_p3':
                case 'view_p4':
                case 'view_p5':
                    const pid = buttonId.replace('view_', '');
                    await sendProductDetail(wasi_sock, from, pid);
                    break;
                    
                case 'add_p1':
                case 'add_p2':
                case 'add_p3':
                case 'add_p4':
                case 'add_p5':
                    const addPid = buttonId.replace('add_', '');
                    await sock.sendMessage(from, { 
                        text: `✅ Product added to cart!\n\n🛒 View cart by typing: cart` 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
                    break;
                    
                default:
                    await sock.sendMessage(from, { 
                        text: '❌ Unknown option. Please try again.' 
                    });
                    await sendInteractiveMessage(wasi_sock, from);
            }
            return;
        }

        // ============================================================
        // HANDLE TEXT COMMANDS
        // ============================================================
        
        if (text) {
            console.log(`💬 Text: ${text} from ${from}`);
            
            // Greetings
            if (['hi', 'hello', 'start', 'menu', 'hey', 'assalamualaikum'].includes(text)) {
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
            
            // Products
            if (text === 'products' || text === '1') {
                await sendProductsInteractive(wasi_sock, from);
                return;
            }
            
            // Cart
            if (text === 'cart' || text === '2') {
                await sock.sendMessage(from, { text: '🛒 Your cart is empty!' });
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
            
            // Orders
            if (text === 'orders' || text === '3') {
                await sock.sendMessage(from, { text: '📦 No orders yet!' });
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
            
            // Categories
            if (text === 'categories' || text === '4') {
                await sock.sendMessage(from, { text: '📂 Categories: Electronics, Accessories, Clothing, Books' });
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
            
            // Help
            if (text === 'help' || text === '5') {
                await sock.sendMessage(from, { 
                    text: '🆘 *Commands:*\nproducts, cart, orders, categories, help' 
                });
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
            
            // View product
            if (text.startsWith('view ')) {
                const pid = text.replace('view ', '');
                await sendProductDetail(wasi_sock, from, pid);
                return;
            }
            
            // Add to cart
            if (text.startsWith('add ')) {
                const pid = text.replace('add ', '');
                await sock.sendMessage(from, { 
                    text: `✅ Product ${pid} added to cart!\n\nType: cart to view` 
                });
                await sendInteractiveMessage(wasi_sock, from);
                return;
            }
        }

        // Default - send interactive message
        await sendInteractiveMessage(wasi_sock, from);
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
            <title>🛍️ Store Bot</title>
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
                .commands { text-align: left; background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0; font-size: 13px; }
                .commands code { background: #e9ecef; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛍️ Store Bot</h1>
                <p class="subtitle">WhatsApp Business Store</p>
                <div class="status ${connected ? 'online' : 'offline'}">
                    ${connected ? '✅ Connected' : '⏳ Waiting...'}
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
                <div class="commands">
                    <strong>📌 Commands:</strong><br>
                    <code>hi</code> - Start<br>
                    <code>products</code> - View products<br>
                    <code>cart</code> - View cart<br>
                    <code>orders</code> - View orders<br>
                    <code>categories</code> - Categories<br>
                    <code>help</code> - Help
                </div>
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
        console.log(`   Or: products, cart, orders, categories, help`);
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
