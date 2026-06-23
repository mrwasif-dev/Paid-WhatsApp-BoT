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
// STORE DATA (Simple in-memory for this test)
// ============================================================

const STORE_FILE = path.join(__dirname, 'storeData.json');

let storeData = {
    products: [
        { id: 'p1', name: 'iPhone 15 Pro Max', price: 350000, category: 'Electronics', description: '256GB, A17 Chip, 48MP Camera', stock: 10 },
        { id: 'p2', name: 'Samsung Galaxy S24 Ultra', price: 280000, category: 'Electronics', description: '512GB, AI Features, S-Pen', stock: 15 },
        { id: 'p3', name: 'Black Car Perfume', price: 5000, category: 'Accessories', description: 'Premium Long Lasting, 100ml', stock: 3 },
        { id: 'p4', name: 'AirPods Pro', price: 45000, category: 'Accessories', description: 'Noise Cancellation, 24hr Battery', stock: 8 },
        { id: 'p5', name: 'Smart Watch Series 9', price: 65000, category: 'Electronics', description: 'Health Monitor, GPS, Heart Rate', stock: 5 }
    ],
    orders: [],
    tempOrders: {} // key: userJid, value: { products: [], step, name, phone, address, notes }
};

function loadStoreData() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const data = fs.readFileSync(STORE_FILE, 'utf8');
            storeData = JSON.parse(data);
            console.log('✅ Store data loaded');
        } else {
            saveStoreData();
        }
    } catch (e) { console.error('Store load error', e); }
}

function saveStoreData() {
    try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(storeData, null, 2));
    } catch (e) { console.error('Store save error', e); }
}

function getAvailableProducts() {
    return storeData.products.filter(p => p.stock > 0);
}

function getProductById(id) {
    return storeData.products.find(p => p.id === id);
}

function getTempOrder(userJid) {
    if (!storeData.tempOrders[userJid]) {
        storeData.tempOrders[userJid] = {
            products: [],
            step: 'main', // main, products, productDetail, cart, checkout_name, checkout_phone, checkout_address, checkout_notes, confirm
            name: '',
            phone: '',
            address: '',
            notes: '',
            selectedProductId: null
        };
        saveStoreData();
    }
    return storeData.tempOrders[userJid];
}

function addToTempOrder(userJid, productId, quantity = 1) {
    const product = getProductById(productId);
    if (!product || product.stock < quantity) return false;
    const temp = getTempOrder(userJid);
    const existing = temp.products.find(p => p.productId === productId);
    if (existing) {
        existing.quantity += quantity;
    } else {
        temp.products.push({ productId, quantity, price: product.price });
    }
    temp.total = temp.products.reduce((sum, p) => {
        const prod = getProductById(p.productId);
        return sum + (prod ? prod.price * p.quantity : 0);
    }, 0);
    saveStoreData();
    return true;
}

function removeFromTempOrder(userJid, productId) {
    const temp = getTempOrder(userJid);
    temp.products = temp.products.filter(p => p.productId !== productId);
    temp.total = temp.products.reduce((sum, p) => {
        const prod = getProductById(p.productId);
        return sum + (prod ? prod.price * p.quantity : 0);
    }, 0);
    saveStoreData();
    return true;
}

function clearTempOrder(userJid) {
    storeData.tempOrders[userJid] = null;
    saveStoreData();
}

function placeOrder(userJid) {
    const temp = getTempOrder(userJid);
    if (temp.products.length === 0) return null;
    if (!temp.name || !temp.phone || !temp.address) return null;

    const order = {
        id: `ORD${Date.now()}`,
        userId: userJid,
        name: temp.name,
        phone: temp.phone,
        address: temp.address,
        notes: temp.notes || '',
        items: temp.products.map(p => ({
            productId: p.productId,
            quantity: p.quantity,
            price: p.price
        })),
        totalAmount: temp.total,
        status: 'Pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Update stock
    for (const item of temp.products) {
        const product = getProductById(item.productId);
        if (product) {
            product.stock -= item.quantity;
        }
    }

    storeData.orders.push(order);
    clearTempOrder(userJid);
    saveStoreData();
    return order;
}

function getUserOrders(userJid) {
    return storeData.orders.filter(o => o.userId === userJid);
}

// ============================================================
// TEXT MENU GENERATORS
// ============================================================

function getMainMenu() {
    return `🛍️ *Welcome to Our Store!*

📱 *WhatsApp Business Store*

Please select an option by typing the number:

1️⃣ *Products* - View available products
2️⃣ *Cart* - View your shopping cart
3️⃣ *Orders* - View your order history
4️⃣ *Help* - How to use the store

Type the number (1-4) or the command name.`;
}

function getProductList() {
    const products = getAvailableProducts();
    if (products.length === 0) {
        return `📭 *No products available*

Please check back later.

Type *menu* to go back.`;
    }
    let text = `🛍️ *Products List*\n\n`;
    products.forEach((p, index) => {
        text += `${index+1}. *${p.name}* - Rs. ${p.price.toLocaleString()}\n`;
        text += `   📦 Stock: ${p.stock}\n`;
    });
    text += `\nTo view a product, type the number (e.g., *1*) or *view <product_id>* (e.g., *view p1*).\n\nType *menu* for main menu.`;
    return text;
}

function getProductDetail(productId) {
    const product = getProductById(productId);
    if (!product) {
        return `❌ Product not found.\n\nType *products* to see the list.`;
    }
    return `🛍️ *${product.name}*

📝 ${product.description}

💰 *Price:* Rs. ${product.price.toLocaleString()}
📂 *Category:* ${product.category}
📦 *Stock:* ${product.stock} units

To add to cart, type *add ${product.id}* (e.g., *add p1*)
To go back to products, type *products*
To main menu, type *menu*`;
}

function getCart(userJid) {
    const temp = getTempOrder(userJid);
    if (temp.products.length === 0) {
        return `🛒 *Your Cart*

Your cart is empty.

Type *products* to start shopping.`;
    }
    let text = `🛒 *Your Cart*\n\n`;
    let total = 0;
    temp.products.forEach((item, index) => {
        const product = getProductById(item.productId);
        if (product) {
            const itemTotal = product.price * item.quantity;
            total += itemTotal;
            text += `${index+1}. *${product.name}* - ${item.quantity}x Rs. ${product.price.toLocaleString()} = Rs. ${itemTotal.toLocaleString()}\n`;
            text += `   To remove: *remove ${product.id}*\n`;
        }
    });
    text += `\n💰 *Total: Rs. ${total.toLocaleString()}*\n\n`;
    text += `To checkout, type *checkout*\n`;
    text += `To clear cart, type *clearcart*\n`;
    text += `To continue shopping, type *products*\n`;
    text += `Type *menu* for main menu.`;
    return text;
}

function getOrders(userJid) {
    const orders = getUserOrders(userJid);
    if (orders.length === 0) {
        return `📦 *My Orders*

You have no orders yet.

Type *products* to start shopping.`;
    }
    let text = `📦 *My Orders*\n\n`;
    orders.forEach((order, index) => {
        const statusEmoji = {
            'Pending': '⏳',
            'Processing': '🔄',
            'Shipped': '🚚',
            'Delivered': '✅',
            'Cancelled': '❌'
        };
        text += `${index+1}. *${order.id}* ${statusEmoji[order.status] || '📦'}\n`;
        text += `   📅 ${new Date(order.createdAt).toLocaleDateString()}\n`;
        text += `   💰 Rs. ${order.totalAmount.toLocaleString()}\n`;
        text += `   📊 ${order.status}\n\n`;
    });
    text += `Type *menu* for main menu.`;
    return text;
}

function getHelp() {
    return `🆘 *Help & Information*

📖 *How to use the Store:*

1. Type a number to select an option from menus.
2. Use commands like *products*, *cart*, *orders*, *menu*.
3. To view a product, type *view p1* or the product number.
4. To add to cart, type *add p1*.
5. To checkout, type *checkout* and follow the prompts.
6. You will be asked for *Name*, *Phone*, *Address*.
7. Confirm your order when asked.

🛍️ *Happy Shopping!*

Type *menu* to return.`;
}

// ============================================================
// START SESSION
// ============================================================

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} already connected.`);
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
            console.log(`Session ${sessionId} closed, reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 3000);
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
    // MESSAGE HANDLER - TEXT MENU SYSTEM
    // ============================================================

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const from = wasi_msg.key.remoteJid;
        const isFromMe = wasi_msg.key.fromMe;
        if (isFromMe) return;

        let text = '';
        if (wasi_msg.message?.conversation) {
            text = wasi_msg.message.conversation.trim();
        } else if (wasi_msg.message?.extendedTextMessage?.text) {
            text = wasi_msg.message.extendedTextMessage.text.trim();
        } else {
            // ignore other types
            return;
        }

        console.log(`💬 From ${from}: ${text}`);

        // Get user's temp order state
        const temp = getTempOrder(from);
        let response = '';

        // ============================================================
        // 1. Check if user is in checkout flow
        // ============================================================
        if (temp.step === 'checkout_name') {
            temp.name = text;
            temp.step = 'checkout_phone';
            saveStoreData();
            response = `✅ Name saved: *${temp.name}*

📱 Now please send your *Phone Number* (e.g., 03001234567):`;
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        if (temp.step === 'checkout_phone') {
            // Basic phone validation (simple)
            const phoneRegex = /^[0-9+\-() ]+$/;
            if (!phoneRegex.test(text) || text.length < 10) {
                response = `❌ Please enter a valid phone number (e.g., 03001234567):`;
                await wasi_sock.sendMessage(from, { text: response });
                return;
            }
            temp.phone = text;
            temp.step = 'checkout_address';
            saveStoreData();
            response = `✅ Phone saved: *${temp.phone}*

📍 Now please send your *Delivery Address* (complete address):`;
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        if (temp.step === 'checkout_address') {
            temp.address = text;
            temp.step = 'checkout_notes';
            saveStoreData();
            response = `✅ Address saved: *${temp.address}*

📝 Optional: Send any *Notes* for your order (or type *skip*):`;
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        if (temp.step === 'checkout_notes') {
            if (text.toLowerCase() !== 'skip') {
                temp.notes = text;
            }
            temp.step = 'confirm';
            saveStoreData();

            // Show order summary
            let summary = `📝 *Order Summary*\n\n`;
            let total = 0;
            for (const item of temp.products) {
                const product = getProductById(item.productId);
                if (product) {
                    const itemTotal = product.price * item.quantity;
                    total += itemTotal;
                    summary += `${product.name} x${item.quantity} = Rs. ${itemTotal.toLocaleString()}\n`;
                }
            }
            summary += `\n💰 *Total: Rs. ${total.toLocaleString()}*\n\n`;
            summary += `👤 Name: ${temp.name}\n`;
            summary += `📱 Phone: ${temp.phone}\n`;
            summary += `📍 Address: ${temp.address}\n`;
            if (temp.notes) summary += `📝 Notes: ${temp.notes}\n`;
            summary += `\n✅ To confirm your order, type *confirm*\n❌ To cancel, type *cancel*`;

            await wasi_sock.sendMessage(from, { text: summary });
            return;
        }

        if (temp.step === 'confirm') {
            if (text.toLowerCase() === 'confirm') {
                const order = placeOrder(from);
                if (order) {
                    let confirmMsg = `✅ *Order Placed Successfully!*\n\n`;
                    confirmMsg += `🆔 Order ID: *${order.id}*\n`;
                    confirmMsg += `👤 Name: ${order.name}\n`;
                    confirmMsg += `📱 Phone: ${order.phone}\n`;
                    confirmMsg += `📍 Address: ${order.address}\n`;
                    confirmMsg += `💰 Total: Rs. ${order.totalAmount.toLocaleString()}\n`;
                    confirmMsg += `📊 Status: ${order.status}\n\n`;
                    confirmMsg += `📦 We'll contact you soon for delivery.\n\n`;
                    confirmMsg += `Type *menu* to continue.`;
                    await wasi_sock.sendMessage(from, { text: confirmMsg });
                } else {
                    await wasi_sock.sendMessage(from, { text: '❌ Failed to place order. Please try again.' });
                }
                // Reset temp order
                clearTempOrder(from);
                return;
            } else if (text.toLowerCase() === 'cancel') {
                clearTempOrder(from);
                await wasi_sock.sendMessage(from, { text: '❌ Order cancelled.\n\nType *menu* to continue.' });
                return;
            } else {
                await wasi_sock.sendMessage(from, { text: '❌ Please type *confirm* or *cancel*.' });
                return;
            }
        }

        // ============================================================
        // 2. If not in checkout flow, process commands
        // ============================================================

        const lowerText = text.toLowerCase();

        // Help
        if (lowerText === 'help' || lowerText === '4') {
            response = getHelp();
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Menu
        if (lowerText === 'menu' || lowerText === 'main' || lowerText === 'start' || lowerText === 'hi' || lowerText === 'hello') {
            response = getMainMenu();
            await wasi_sock.sendMessage(from, { text: response });
            // Reset any partial checkout state? (optional)
            if (temp.step !== 'main' && temp.step !== 'products' && temp.step !== 'productDetail' && temp.step !== 'cart') {
                // If they were in checkout flow, reset it
                if (temp.step.startsWith('checkout_') || temp.step === 'confirm') {
                    clearTempOrder(from);
                    // Recreate temp with main step
                    getTempOrder(from);
                }
            }
            return;
        }

        // Products
        if (lowerText === 'products' || lowerText === '1') {
            temp.step = 'products';
            saveStoreData();
            response = getProductList();
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Cart
        if (lowerText === 'cart' || lowerText === '2') {
            temp.step = 'cart';
            saveStoreData();
            response = getCart(from);
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Orders
        if (lowerText === 'orders' || lowerText === '3') {
            response = getOrders(from);
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Checkout
        if (lowerText === 'checkout') {
            const cartItems = temp.products;
            if (cartItems.length === 0) {
                response = `❌ Your cart is empty!\n\nAdd products first using *products* menu.`;
                await wasi_sock.sendMessage(from, { text: response });
                return;
            }
            // Start checkout flow
            temp.step = 'checkout_name';
            saveStoreData();
            response = `📝 *Checkout Started*\n\nPlease enter your *Full Name*:`;
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // Clear cart
        if (lowerText === 'clearcart') {
            clearTempOrder(from);
            response = `🗑️ Cart cleared successfully.\n\nType *menu* to continue.`;
            await wasi_sock.sendMessage(from, { text: response });
            return;
        }

        // View product by number (1,2,3...)
        const numMatch = lowerText.match(/^(\d+)$/);
        if (numMatch) {
            const num = parseInt(numMatch[1]);
            const products = getAvailableProducts();
            if (num >= 1 && num <= products.length) {
                const product = products[num - 1];
                temp.selectedProductId = product.id;
                temp.step = 'productDetail';
                saveStoreData();
                response = getProductDetail(product.id);
                await wasi_sock.sendMessage(from, { text: response });
                return;
            } else {
                response = `❌ Invalid number. Please type a number from 1 to ${products.length}.`;
                await wasi_sock.sendMessage(from, { text: response });
                return;
            }
        }

        // View product by id (view p1)
        if (lowerText.startsWith('view ')) {
            const productId = lowerText.replace('view ', '').trim();
            const product = getProductById(productId);
            if (product) {
                temp.selectedProductId = product.id;
                temp.step = 'productDetail';
                saveStoreData();
                response = getProductDetail(product.id);
                await wasi_sock.sendMessage(from, { text: response });
            } else {
                response = `❌ Product not found. Try *products* to see available items.`;
                await wasi_sock.sendMessage(from, { text: response });
            }
            return;
        }

        // Add to cart (add p1)
        if (lowerText.startsWith('add ')) {
            const productId = lowerText.replace('add ', '').trim();
            const product = getProductById(productId);
            if (!product) {
                response = `❌ Product not found. Try *products* to see available items.`;
                await wasi_sock.sendMessage(from, { text: response });
                return;
            }
            if (product.stock <= 0) {
                response = `❌ ${product.name} is out of stock.`;
                await wasi_sock.sendMessage(from, { text: response });
                return;
            }
            // Add 1 quantity by default
            const success = addToTempOrder(from, productId, 1);
            if (success) {
                response = `✅ Added *${product.name}* to your cart!\n\nType *cart* to view or *checkout* to place order.`;
                await wasi_sock.sendMessage(from, { text: response });
            } else {
                response = `❌ Could not add to cart.`;
                await wasi_sock.sendMessage(from, { text: response });
            }
            return;
        }

        // Remove from cart (remove p1)
        if (lowerText.startsWith('remove ')) {
            const productId = lowerText.replace('remove ', '').trim();
            const product = getProductById(productId);
            const success = removeFromTempOrder(from, productId);
            if (success) {
                response = `✅ Removed ${product ? product.name : 'item'} from cart.`;
                await wasi_sock.sendMessage(from, { text: response });
                // Show updated cart
                const cartMsg = getCart(from);
                await wasi_sock.sendMessage(from, { text: cartMsg });
            } else {
                response = `❌ Item not found in cart.`;
                await wasi_sock.sendMessage(from, { text: response });
            }
            return;
        }

        // If none matched, show main menu
        response = `❌ I didn't understand that.\n\n` + getMainMenu();
        await wasi_sock.sendMessage(from, { text: response });
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
    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) {}
        }
    }
    res.json({ sessionId, connected, qr: qrDataUrl, activeSessions: Array.from(sessions.keys()) });
});

wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

wasi_app.get('/', (req, res) => {
    const sessionId = config.sessionId || 'test_session';
    const session = sessions.get(sessionId);
    const connected = session?.isConnected || false;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>🛍️ Store Bot</title>
        <style>
            body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
            .status { color: ${connected ? 'green' : 'red'}; font-weight: bold; }
        </style>
        </head>
        <body>
            <div class="container">
                <h1>🛍️ Store Bot</h1>
                <p class="status">${connected ? '✅ Connected' : '❌ Disconnected'}</p>
                <p>Scan QR to connect: <a href="/api/status">Get QR</a></p>
                <p>Session: ${sessionId}</p>
            </div>
        </body>
        </html>
    `);
});

// ============================================================
// SERVER START
// ============================================================

function startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`\n🌐 Server running on port ${wasi_port}`);
        console.log(`📌 Web: http://localhost:${wasi_port}`);
        console.log(`📌 Status: http://localhost:${wasi_port}/api/status`);
        console.log(`\n✅ Bot is ready! Send "hi" on WhatsApp.`);
    });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('🛍️ Starting Store Bot (Text Menu)...');
    loadStoreData();
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }
    const sessionId = config.sessionId || 'test_session';
    await startSession(sessionId);
    startServer();
}

main();
