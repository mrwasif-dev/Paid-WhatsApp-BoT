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

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

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

const QRCode = require('qrcode');

// ============================================================
// STORE SYSTEM - مکمل اسٹور سسٹم (FIXED)
// ============================================================

const STORE_FILE = path.join(__dirname, 'storeData.json');

let storeData = {
    products: [],
    orders: [],
    tempOrders: {},
    categories: ['Electronics', 'Clothing', 'Books', 'Accessories', 'Other']
};

function loadStoreData() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const data = fs.readFileSync(STORE_FILE, 'utf8');
            storeData = JSON.parse(data);
            console.log('✅ Store data loaded');
        } else {
            storeData.products = [
                {
                    id: 'p1',
                    name: 'iPhone 15 Pro',
                    price: 350000,
                    category: 'Electronics',
                    description: 'Latest iPhone with A17 chip, 256GB storage',
                    stock: 10,
                    createdAt: new Date().toISOString()
                },
                {
                    id: 'p2',
                    name: 'Samsung Galaxy S24',
                    price: 280000,
                    category: 'Electronics',
                    description: 'Premium Android phone with AI features',
                    stock: 15,
                    createdAt: new Date().toISOString()
                },
                {
                    id: 'p3',
                    name: 'Black Car Perfume',
                    price: 5000,
                    category: 'Accessories',
                    description: 'Premium car air freshener',
                    stock: 3,
                    createdAt: new Date().toISOString()
                }
            ];
            storeData.orders = [];
            storeData.tempOrders = {};
            saveStoreData();
        }
    } catch (error) {
        console.error('Error loading store:', error);
    }
}

function saveStoreData() {
    try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(storeData, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving store:', error);
        return false;
    }
}

function getAvailableProducts() {
    return storeData.products.filter(p => p.stock > 0);
}

function getProductById(id) {
    return storeData.products.find(p => p.id === id);
}

function addProduct(product) {
    product.id = `p${Date.now()}`;
    product.createdAt = new Date().toISOString();
    storeData.products.push(product);
    saveStoreData();
    return product;
}

function deleteProduct(id) {
    storeData.products = storeData.products.filter(p => p.id !== id);
    saveStoreData();
    return true;
}

function getTempOrder(userJid) {
    if (!storeData.tempOrders[userJid]) {
        storeData.tempOrders[userJid] = {
            products: [],
            total: 0,
            step: 'browsing',
            address: '',
            phone: '',
            name: '',
            notes: ''
        };
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
    if (!temp.address || !temp.phone || !temp.name) return null;

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

function getOrderById(orderId) {
    return storeData.orders.find(o => o.id === orderId);
}

function updateOrderStatus(orderId, status) {
    const order = getOrderById(orderId);
    if (order) {
        order.status = status;
        order.updatedAt = new Date().toISOString();
        saveStoreData();
        return order;
    }
    return null;
}

function getAllOrders() {
    return storeData.orders;
}

function getStats() {
    const products = getAvailableProducts();
    const orders = getAllOrders();
    return {
        totalProducts: products.length,
        totalOrders: orders.length,
        pendingOrders: orders.filter(o => o.status === 'Pending' || o.status === 'Processing').length,
        totalRevenue: orders.filter(o => o.status === 'Delivered' || o.status === 'Shipped')
            .reduce((sum, o) => sum + o.totalAmount, 0)
    };
}

// ============================================================
// BUTTONS GENERATOR - FIXED for WhatsApp
// ============================================================

function createProductButtons(products) {
    const buttons = [];
    for (const p of products) {
        buttons.push({
            buttonId: `view_${p.id}`,
            buttonText: { displayText: `📱 ${p.name}` },
            type: 1
        });
    }
    buttons.push({
        buttonId: 'view_cart',
        buttonText: { displayText: '🛒 My Cart' },
        type: 1
    });
    buttons.push({
        buttonId: 'my_orders',
        buttonText: { displayText: '📦 My Orders' },
        type: 1
    });
    return buttons;
}

function createProductDetailButtons(productId) {
    return [
        {
            buttonId: `add_${productId}`,
            buttonText: { displayText: '🛒 Add to Cart' },
            type: 1
        },
        {
            buttonId: `view_${productId}_qty2`,
            buttonText: { displayText: '➕ Add 2x' },
            type: 1
        },
        {
            buttonId: 'back_to_products',
            buttonText: { displayText: '⬅️ Back' },
            type: 1
        },
        {
            buttonId: 'view_cart',
            buttonText: { displayText: '🛒 Cart' },
            type: 1
        }
    ];
}

function createCartButtons() {
    return [
        {
            buttonId: 'checkout',
            buttonText: { displayText: '✅ Checkout' },
            type: 1
        },
        {
            buttonId: 'clear_cart',
            buttonText: { displayText: '🗑️ Clear Cart' },
            type: 1
        },
        {
            buttonId: 'back_to_products',
            buttonText: { displayText: '⬅️ Continue Shopping' },
            type: 1
        }
    ];
}

function createCheckoutButtons() {
    return [
        {
            buttonId: 'confirm_order',
            buttonText: { displayText: '✅ Confirm Order' },
            type: 1
        },
        {
            buttonId: 'back_to_cart',
            buttonText: { displayText: '⬅️ Back to Cart' },
            type: 1
        }
    ];
}

function createOrderButtons() {
    return [
        {
            buttonId: 'back_to_products',
            buttonText: { displayText: '🛍️ Continue Shopping' },
            type: 1
        },
        {
            buttonId: 'view_cart',
            buttonText: { displayText: '🛒 View Cart' },
            type: 1
        }
    ];
}

function createMainMenuButtons() {
    return [
        {
            buttonId: 'back_to_products',
            buttonText: { displayText: '🛍️ Shop Now' },
            type: 1
        },
        {
            buttonId: 'view_cart',
            buttonText: { displayText: '🛒 My Cart' },
            type: 1
        },
        {
            buttonId: 'my_orders',
            buttonText: { displayText: '📦 My Orders' },
            type: 1
        }
    ];
}

// ============================================================
// MESSAGE GENERATORS
// ============================================================

function generateProductListMessage(products) {
    if (products.length === 0) {
        return {
            text: '🛍️ *No products available right now!*\n\nPlease check back later.',
            buttons: []
        };
    }

    let text = '🛍️ *Welcome to Our Store!*\n\n';
    text += '🛒 *Browse our collection:*\n\n';
    
    for (const p of products) {
        text += `📱 *${p.name}*\n`;
        text += `💰 Rs. ${p.price.toLocaleString()}\n`;
        text += `📂 ${p.category}\n`;
        text += `📦 Stock: ${p.stock}\n`;
        text += `─────────────\n\n`;
    }
    
    text += '👇 *Tap a button below to view product details.*';

    return { text, buttons: createProductButtons(products) };
}

function generateProductDetailMessage(product) {
    let text = `🛍️ *${product.name}*\n\n`;
    text += `📝 ${product.description || 'No description'}\n\n`;
    text += `💰 Price: Rs. ${product.price.toLocaleString()}\n`;
    text += `📂 Category: ${product.category}\n`;
    text += `📦 Stock: ${product.stock}\n\n`;
    text += '👇 *Tap a button below:*';

    return { text, buttons: createProductDetailButtons(product.id) };
}

function generateCartMessage(userJid) {
    const temp = getTempOrder(userJid);
    
    if (temp.products.length === 0) {
        return {
            text: '🛒 *Your cart is empty!*\n\nBrowse products and add items to your cart.',
            buttons: [
                {
                    buttonId: 'back_to_products',
                    buttonText: { displayText: '🛍️ Browse Products' },
                    type: 1
                }
            ]
        };
    }

    let text = '🛒 *Your Cart*\n\n';
    let total = 0;
    let index = 1;
    
    for (const item of temp.products) {
        const product = getProductById(item.productId);
        if (product) {
            const itemTotal = product.price * item.quantity;
            total += itemTotal;
            text += `${index}. *${product.name}*\n`;
            text += `   ${item.quantity}x Rs. ${product.price.toLocaleString()} = Rs. ${itemTotal.toLocaleString()}\n`;
            text += `   ➖ Remove: type \`remove_${product.id}\`\n\n`;
            index++;
        }
    }
    
    text += `💰 *Total: Rs. ${total.toLocaleString()}*\n\n`;
    text += '👇 *Tap a button below:*';

    return { text, buttons: createCartButtons() };
}

function generateCheckoutMessage(userJid) {
    const temp = getTempOrder(userJid);
    
    if (temp.products.length === 0) {
        return { text: '❌ Your cart is empty!', buttons: [] };
    }

    let text = '📝 *Order Summary*\n\n';
    let total = 0;
    
    for (const item of temp.products) {
        const product = getProductById(item.productId);
        if (product) {
            const itemTotal = product.price * item.quantity;
            total += itemTotal;
            text += `📱 ${product.name} x${item.quantity} = Rs. ${itemTotal.toLocaleString()}\n`;
        }
    }
    
    text += `\n💰 *Total: Rs. ${total.toLocaleString()}*\n\n`;
    
    if (temp.name) text += `👤 Name: ${temp.name}\n`;
    if (temp.phone) text += `📱 Phone: ${temp.phone}\n`;
    if (temp.address) text += `📍 Address: ${temp.address}\n`;
    if (temp.notes) text += `📝 Notes: ${temp.notes}\n`;
    
    if (!temp.name || !temp.phone || !temp.address) {
        text += '\n⚠️ *Please provide the following information:*\n';
        if (!temp.name) text += '• Your full name\n';
        if (!temp.phone) text += '• Phone number\n';
        if (!temp.address) text += '• Delivery address\n';
        text += '\n_Type your information one by one:_\n';
        text += '1️⃣ Name\n2️⃣ Phone\n3️⃣ Address\n4️⃣ Notes (optional)';
        text += '\n\n👇 *Tap Confirm when ready:*';
    } else {
        text += '\n✅ All information provided!\n👇 *Tap Confirm Order to place your order.*';
    }

    return { text, buttons: createCheckoutButtons() };
}

function generateOrderConfirmationMessage(order) {
    let text = '✅ *Order Placed Successfully!*\n\n';
    text += `🆔 Order ID: *${order.id}*\n`;
    text += `👤 Name: ${order.name}\n`;
    text += `📱 Phone: ${order.phone}\n`;
    text += `📍 Address: ${order.address}\n`;
    text += `💰 Total: Rs. ${order.totalAmount.toLocaleString()}\n`;
    text += `📊 Status: ${order.status}\n\n`;
    text += '*Order Items:*\n';
    
    for (const item of order.items) {
        const product = getProductById(item.productId);
        if (product) {
            text += `• ${product.name} x${item.quantity} = Rs. ${(item.price * item.quantity).toLocaleString()}\n`;
        }
    }
    
    text += '\n📦 We\'ll contact you soon for delivery confirmation!\n\n👇 *Tap a button below:*';
    
    return { text, buttons: createOrderButtons() };
}

function generateOrderListMessage(userJid) {
    const orders = getUserOrders(userJid);
    
    if (orders.length === 0) {
        return {
            text: '📭 *No orders found*\n\nYou haven\'t placed any orders yet.',
            buttons: [
                {
                    buttonId: 'back_to_products',
                    buttonText: { displayText: '🛍️ Start Shopping' },
                    type: 1
                }
            ]
        };
    }

    let text = '📦 *Your Orders*\n\n';
    for (const order of orders) {
        const statusEmoji = {
            'Pending': '⏳',
            'Processing': '🔄',
            'Shipped': '🚚',
            'Delivered': '✅',
            'Cancelled': '❌'
        };
        text += `${statusEmoji[order.status] || '📦'} *${order.id}*\n`;
        text += `💰 Rs. ${order.totalAmount.toLocaleString()}\n`;
        text += `📊 ${order.status}\n`;
        text += `📅 ${new Date(order.createdAt).toLocaleDateString()}\n`;
        text += `─────────────\n\n`;
    }
    
    text += '👇 *Tap a button below:*';
    
    return {
        text,
        buttons: [
            {
                buttonId: 'back_to_products',
                buttonText: { displayText: '🛍️ Continue Shopping' },
                type: 1
            },
            {
                buttonId: 'view_cart',
                buttonText: { displayText: '🛒 View Cart' },
                type: 1
            }
        ]
    };
}

// ============================================================
// STORE INTERACTION HANDLER - FIXED
// ============================================================

async function handleStoreInteraction(sock, from, message) {
    let buttonId = null;
    let text = null;

    // Check for button response
    if (message?.buttonsResponseMessage?.selectedButtonId) {
        buttonId = message.buttonsResponseMessage.selectedButtonId;
    } else if (message?.templateButtonReplyMessage?.selectedId) {
        buttonId = message.templateButtonReplyMessage.selectedId;
    } else if (message?.conversation) {
        text = message.conversation.trim();
    } else if (message?.extendedTextMessage?.text) {
        text = message.extendedTextMessage.text.trim();
    }

    if (buttonId) {
        return await handleButtonClick(sock, from, buttonId);
    }

    if (text) {
        return await handleTextInput(sock, from, text);
    }

    return false;
}

async function handleButtonClick(sock, from, buttonId) {
    console.log(`Button clicked: ${buttonId} from ${from}`);

    // My Orders
    if (buttonId === 'my_orders') {
        const { text, buttons } = generateOrderListMessage(from);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // View Product
    if (buttonId.startsWith('view_')) {
        const productId = buttonId.replace('view_', '');
        // Check if it's a quantity variant
        if (productId.endsWith('_qty2')) {
            const actualId = productId.replace('_qty2', '');
            const product = getProductById(actualId);
            if (product && product.stock >= 2) {
                addToTempOrder(from, actualId, 2);
                await sock.sendMessage(from, { text: `✅ Added 2x ${product.name} to cart!` });
                const { text: detailText, buttons } = generateProductDetailMessage(product);
                await sendButtonMessage(sock, from, detailText, buttons);
            } else {
                await sock.sendMessage(from, { text: '❌ Not enough stock!' });
            }
            return true;
        }
        
        const product = getProductById(productId);
        if (!product || product.stock <= 0) {
            await sock.sendMessage(from, { text: '❌ This product is out of stock!' });
            return true;
        }

        const { text, buttons } = generateProductDetailMessage(product);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Add to Cart (1x)
    if (buttonId.startsWith('add_')) {
        const productId = buttonId.replace('add_', '');
        const product = getProductById(productId);
        
        if (!product || product.stock <= 0) {
            await sock.sendMessage(from, { text: '❌ Product out of stock!' });
            return true;
        }

        const success = addToTempOrder(from, productId, 1);
        if (success) {
            await sock.sendMessage(from, { text: `✅ Added 1x ${product.name} to cart!` });
            const { text: detailText, buttons } = generateProductDetailMessage(product);
            await sendButtonMessage(sock, from, detailText, buttons);
        } else {
            await sock.sendMessage(from, { text: '❌ Could not add product to cart.' });
        }
        return true;
    }

    // View Cart
    if (buttonId === 'view_cart') {
        const { text, buttons } = generateCartMessage(from);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Checkout
    if (buttonId === 'checkout') {
        const temp = getTempOrder(from);
        if (temp.products.length === 0) {
            await sock.sendMessage(from, { text: '❌ Your cart is empty!' });
            return true;
        }
        const { text, buttons } = generateCheckoutMessage(from);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Back to Products
    if (buttonId === 'back_to_products') {
        const products = getAvailableProducts();
        const { text, buttons } = generateProductListMessage(products);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Clear Cart
    if (buttonId === 'clear_cart') {
        clearTempOrder(from);
        await sock.sendMessage(from, { text: '🗑️ Cart cleared successfully!' });
        const products = getAvailableProducts();
        const { text, buttons } = generateProductListMessage(products);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Back to Cart
    if (buttonId === 'back_to_cart') {
        const { text, buttons } = generateCartMessage(from);
        await sendButtonMessage(sock, from, text, buttons);
        return true;
    }

    // Confirm Order
    if (buttonId === 'confirm_order') {
        const temp = getTempOrder(from);
        if (!temp.name || !temp.phone || !temp.address) {
            await sock.sendMessage(from, { text: '❌ Please provide all required information: Name, Phone, Address' });
            const { text: checkoutText, buttons } = generateCheckoutMessage(from);
            await sendButtonMessage(sock, from, checkoutText, buttons);
            return true;
        }

        const order = placeOrder(from);
        if (order) {
            const { text, buttons } = generateOrderConfirmationMessage(order);
            await sendButtonMessage(sock, from, text, buttons);
        } else {
            await sock.sendMessage(from, { text: '❌ Failed to place order. Please try again.' });
        }
        return true;
    }

    return false;
}

async function handleTextInput(sock, from, text) {
    const temp = getTempOrder(from);
    
    if (temp.products.length === 0) return false;
    
    // Check if it's a remove command
    if (text.startsWith('remove_')) {
        const productId = text.replace('remove_', '');
        const product = getProductById(productId);
        const success = removeFromTempOrder(from, productId);
        if (success) {
            await sock.sendMessage(from, { text: `✅ Removed ${product?.name || 'item'} from cart!` });
            const { text: cartText, buttons } = generateCartMessage(from);
            await sendButtonMessage(sock, from, cartText, buttons);
        }
        return true;
    }
    
    // Order information collection
    if (!temp.name && !temp.phone && !temp.address) {
        temp.name = text;
        temp.step = 'phone';
        saveStoreData();
        await sock.sendMessage(from, { text: `✅ Name saved: ${temp.name}\n\n📱 Now please send your *Phone Number*:` });
        return true;
    } else if (temp.name && !temp.phone) {
        temp.phone = text;
        temp.step = 'address';
        saveStoreData();
        await sock.sendMessage(from, { text: `✅ Phone saved: ${temp.phone}\n\n📍 Now please send your *Delivery Address*:` });
        return true;
    } else if (temp.name && temp.phone && !temp.address) {
        temp.address = text;
        temp.step = 'notes';
        saveStoreData();
        await sock.sendMessage(from, { text: `✅ Address saved: ${temp.address}\n\n📝 Optional: Send any *Notes* for your order (or type "skip")` });
        return true;
    } else if (temp.name && temp.phone && temp.address && !temp.notes) {
        if (text.toLowerCase() !== 'skip') {
            temp.notes = text;
        }
        temp.step = 'confirm';
        saveStoreData();
        const { text: checkoutText, buttons } = generateCheckoutMessage(from);
        await sendButtonMessage(sock, from, checkoutText, buttons);
        return true;
    }

    return false;
}

// ============================================================
// SEND BUTTON MESSAGE - FIXED for WhatsApp
// ============================================================

async function sendButtonMessage(sock, to, text, buttons) {
    try {
        if (!buttons || buttons.length === 0) {
            await sock.sendMessage(to, { text: text });
            return;
        }

        // Create button message
        const buttonMessage = {
            text: text,
            buttons: buttons,
            headerType: 1
        };
        
        await sock.sendMessage(to, buttonMessage);
        console.log(`✅ Button message sent to ${to} with ${buttons.length} buttons`);
        
    } catch (error) {
        console.error('Error sending button message:', error);
        // Fallback - send plain text
        await sock.sendMessage(to, { text: text + '\n\n⚠️ Buttons not supported, please type commands.' });
    }
}

// ============================================================
// SESSION STATE
// ============================================================

const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STORE API ROUTES
// ============================================================

// GET - تمام پروڈکٹس
wasi_app.get('/api/store/products', (req, res) => {
    try {
        const products = getAvailableProducts();
        const stats = getStats();
        res.json({ success: true, products, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST - نیا پروڈکٹ
wasi_app.post('/api/store/products', (req, res) => {
    try {
        const { name, price, category, description, stock } = req.body;
        if (!name || !price) {
            return res.status(400).json({ success: false, message: 'Name and price required' });
        }
        const product = addProduct({
            name,
            price: parseInt(price),
            category: category || 'Other',
            description: description || '',
            stock: parseInt(stock) || 0
        });
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE - پروڈکٹ ڈیلیٹ
wasi_app.delete('/api/store/products/:id', (req, res) => {
    try {
        const deleted = deleteProduct(req.params.id);
        if (deleted) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: 'Product not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET - تمام آرڈرز
wasi_app.get('/api/store/orders', (req, res) => {
    try {
        const orders = getAllOrders().sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        res.json({ success: true, orders });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PATCH - آرڈر اسٹیٹس اپڈیٹ
wasi_app.patch('/api/store/orders/:id', (req, res) => {
    try {
        const { status } = req.body;
        const order = updateOrderStatus(req.params.id, status);
        if (order) {
            const stats = getStats();
            res.json({ success: true, order, stats });
        } else {
            res.status(404).json({ success: false, message: 'Order not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve Admin Panel
wasi_app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// ============================================================
// API: GET STATUS
// ============================================================

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
        activeSessions: Array.from(sessions.keys())
    });
});

wasi_app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// API: RESTART BOT
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
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
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
// API: HEALTH CHECK
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
// SESSION MANAGEMENT
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
            console.log(`QR generated for session: ${sessionId}`);
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
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // ============================================================
    // MESSAGE HANDLER - مکمل اسٹور کے ساتھ (FIXED)
    // ============================================================

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const from = wasi_msg.key.remoteJid;
        const isFromMe = wasi_msg.key.fromMe;

        if (isFromMe) return;

        // Check if user is in temp order flow (collecting info)
        const temp = getTempOrder(from);
        const isInOrderFlow = temp && (temp.name || temp.phone || temp.address || temp.step !== 'browsing');

        // STORE INTERACTION - بٹن اور ٹیکسٹ ان پٹ
        const storeHandled = await handleStoreInteraction(wasi_sock, from, wasi_msg.message);
        if (storeHandled) return;

        // اگر کوئی اسٹور انٹریکشن نہیں تھی اور یوزر آرڈر فل میں نہیں ہے تو مین مینو بھیجیں
        if (!isInOrderFlow) {
            const products = getAvailableProducts();
            if (products.length > 0) {
                const { text, buttons } = generateProductListMessage(products);
                await sendButtonMessage(wasi_sock, from, text, buttons);
            } else {
                await wasi_sock.sendMessage(from, { 
                    text: '🛍️ Welcome to our store!\n\nNo products available right now. Please check back later.' 
                });
            }
        }
    });
}

// ============================================================
// SERVER START
// ============================================================

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🛍️ Store System Active`);
        console.log(`📊 Products: ${getAvailableProducts().length}`);
        console.log(`📋 Orders: ${getAllOrders().length}`);
        console.log(`\n📌 Admin Panel: http://localhost:${wasi_port}/admin`);
        console.log(`📌 API Endpoints:`);
        console.log(`   GET  /api/store/products  - Get products`);
        console.log(`   POST /api/store/products  - Add product`);
        console.log(`   DELETE /api/store/products/:id - Delete product`);
        console.log(`   GET  /api/store/orders    - Get orders`);
        console.log(`   PATCH /api/store/orders/:id - Update order`);
        console.log(`   GET  /api/status          - Bot status`);
        console.log(`   POST /api/restart         - Restart bot`);
        console.log(`   POST /api/logout          - Logout bot`);
    });
}

// ============================================================
// MAIN STARTUP
// ============================================================

async function main() {
    // 1. STORE DATA LOAD
    loadStoreData();
    console.log('✅ Store system initialized');

    // 2. Connect DB if configured
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    // 3. Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // 4. Start server
    wasi_startServer();
}

main();
