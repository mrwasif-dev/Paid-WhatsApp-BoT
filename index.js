
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
const mongoose = require('mongoose');
const QRCode = require('qrcode');

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

// -----------------------------------------------------------------------------
// MONGODB MODEL (Inline)
// -----------------------------------------------------------------------------
let Payment;
let isDBConnected = false;

async function initDB() {
    try {
        if (config.mongoDbUrl) {
            await mongoose.connect(config.mongoDbUrl);
            isDBConnected = true;
            console.log('✅ MongoDB connected');

            // Define Payment Schema
            const paymentSchema = new mongoose.Schema({
                userId: { type: String, required: true, unique: true },
                phoneNumber: { type: String, required: true },
                trailStart: { type: Date, default: Date.now },
                trailEnd: { type: Date },
                paymentDate: { type: Date },
                paymentExpiry: { type: Date },
                isActive: { type: Boolean, default: false },
                isPaid: { type: Boolean, default: false },
                paymentMethod: { type: String },
                paymentScreenshot: { type: String },
                adminApproval: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
                sessionId: { type: String },
                botActive: { type: Boolean, default: false },
                createdAt: { type: Date, default: Date.now }
            });

            Payment = mongoose.model('Payment', paymentSchema);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        return false;
    }
}

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const ADMIN_JID = '03039107958@s.whatsapp.net';
const FREE_TRAIL_HOURS = 2;
const SUBSCRIPTION_DAYS = 30;
const SUBSCRIPTION_PRICE = 500;

// Payment Accounts
const PAYMENT_ACCOUNTS = {
    jazzcash: {
        name: 'Muhammad Akram',
        number: '03039107958',
        type: 'JazzCash'
    },
    easypaisa: {
        name: 'Karman Mai',
        number: '03039107958',
        type: 'EasyPaisa'
    },
    upaisa: {
        name: 'Karman',
        number: '03039107958',
        type: 'UPaisa'
    },
    rast: {
        name: 'Muzammal',
        number: '03039107958',
        type: 'Rast'
    }
};

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();
const userSessions = new Map();
const pendingPayments = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));
wasi_app.use(express.urlencoded({ extended: true }));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// PAYMENT FUNCTIONS
// -----------------------------------------------------------------------------

// Check if user has access
async function checkUserAccess(userId) {
    try {
        if (!isDBConnected || !Payment) return true; // If no DB, allow access
        
        const user = await Payment.findOne({ userId });
        if (!user) return false;

        const now = new Date();
        
        // Check trail
        if (user.trailEnd && now < user.trailEnd) {
            return true;
        }
        
        // Check paid subscription
        if (user.paymentExpiry && now < user.paymentExpiry && user.isPaid) {
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error checking user access:', error);
        return false;
    }
}

// Get user payment info
async function getUserPaymentInfo(userId) {
    try {
        if (!isDBConnected || !Payment) return null;
        return await Payment.findOne({ userId });
    } catch (error) {
        console.error('Error getting user payment info:', error);
        return null;
    }
}

// Create or update user
async function createOrUpdateUser(userId, phoneNumber) {
    try {
        if (!isDBConnected || !Payment) return null;
        
        let user = await Payment.findOne({ userId });
        const now = new Date();
        
        if (!user) {
            // New user - start free trail
            const trailEnd = new Date(now.getTime() + FREE_TRAIL_HOURS * 60 * 60 * 1000);
            user = new Payment({
                userId,
                phoneNumber,
                trailStart: now,
                trailEnd: trailEnd,
                isActive: true,
                botActive: true
            });
            await user.save();
            console.log(`🆕 New user created: ${userId} with trail until ${trailEnd}`);
        } else {
            // Update phone number if changed
            if (user.phoneNumber !== phoneNumber) {
                user.phoneNumber = phoneNumber;
                await user.save();
            }
        }
        
        return user;
    } catch (error) {
        console.error('Error creating/updating user:', error);
        return null;
    }
}

// Process payment
async function processPayment(userId, method, screenshot) {
    try {
        if (!isDBConnected || !Payment) return null;
        
        const user = await Payment.findOne({ userId });
        if (!user) return null;
        
        user.paymentMethod = method;
        user.paymentScreenshot = screenshot;
        user.adminApproval = 'pending';
        user.isPaid = false;
        user.botActive = false; // Deactivate until admin approves
        await user.save();
        
        return user;
    } catch (error) {
        console.error('Error processing payment:', error);
        return null;
    }
}

// Admin approve payment
async function approvePayment(userId) {
    try {
        if (!isDBConnected || !Payment) return null;
        
        const user = await Payment.findOne({ userId });
        if (!user) return null;
        
        const now = new Date();
        user.isPaid = true;
        user.adminApproval = 'approved';
        user.paymentDate = now;
        user.paymentExpiry = new Date(now.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);
        user.botActive = true;
        user.isActive = true;
        await user.save();
        
        // Start user's bot session
        await startUserSession(userId, user.phoneNumber);
        
        return user;
    } catch (error) {
        console.error('Error approving payment:', error);
        return null;
    }
}

// Admin reject payment
async function rejectPayment(userId) {
    try {
        if (!isDBConnected || !Payment) return null;
        
        const user = await Payment.findOne({ userId });
        if (!user) return null;
        
        user.adminApproval = 'rejected';
        user.botActive = false;
        user.isActive = false;
        await user.save();
        
        return user;
    } catch (error) {
        console.error('Error rejecting payment:', error);
        return null;
    }
}

// Start user's bot session
async function startUserSession(userId, phoneNumber) {
    try {
        const sessionId = `user_${userId}`;
        
        // Check if session already exists
        if (sessions.has(sessionId)) {
            console.log(`Session already exists for ${userId}`);
            return true;
        }
        
        // Start the session
        await startSession(sessionId, userId);
        userSessions.set(userId, sessionId);
        
        console.log(`✅ Started session for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Error starting session for ${userId}:`, error);
        return false;
    }
}

// Stop user's bot session
async function stopUserSession(userId) {
    try {
        const sessionId = userSessions.get(userId);
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            if (session.sock) {
                await session.sock.end(undefined);
            }
            sessions.delete(sessionId);
            userSessions.delete(userId);
            console.log(`🛑 Stopped session for ${userId}`);
        }
    } catch (error) {
        console.error(`Error stopping session for ${userId}:`, error);
    }
}

// -----------------------------------------------------------------------------
// SCHEDULED TASKS
// -----------------------------------------------------------------------------

// Check expired trails every minute
cron.schedule('* * * * *', async () => {
    if (!isDBConnected || !Payment) return;
    
    try {
        const now = new Date();
        const expiredUsers = await Payment.find({
            trailEnd: { $lt: now },
            isPaid: false,
            botActive: true
        });
        
        for (const user of expiredUsers) {
            console.log(`⏰ Trail expired for user: ${user.userId}`);
            user.botActive = false;
            user.isActive = false;
            await user.save();
            
            // Stop their bot session
            await stopUserSession(user.userId);
            
            // Send notification to user
            const sessionId = userSessions.get(user.userId);
            if (sessionId && sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                if (session.sock && session.isConnected) {
                    try {
                        await session.sock.sendMessage(`${user.userId}@s.whatsapp.net`, {
                            text: `⏰ *Your free trail has expired!*\n\nPlease subscribe to continue using the bot.\n\n📌 *Subscription Price:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nTo subscribe, visit our website or send payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}`
                        });
                    } catch (e) {
                        console.error('Error sending expiry notification:', e);
                    }
                }
            }
        }
        
        // Check expired paid subscriptions
        const expiredPaid = await Payment.find({
            paymentExpiry: { $lt: now },
            isPaid: true,
            botActive: true
        });
        
        for (const user of expiredPaid) {
            console.log(`⏰ Subscription expired for user: ${user.userId}`);
            user.isPaid = false;
            user.botActive = false;
            user.isActive = false;
            await user.save();
            
            await stopUserSession(user.userId);
            
            // Send notification
            const sessionId = userSessions.get(user.userId);
            if (sessionId && sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                if (session.sock && session.isConnected) {
                    try {
                        await session.sock.sendMessage(`${user.userId}@s.whatsapp.net`, {
                            text: `⏰ *Your subscription has expired!*\n\nPlease renew your subscription to continue using the bot.\n\n📌 *Renewal Price:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nTo renew, visit our website or send payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}`
                        });
                    } catch (e) {
                        console.error('Error sending expiry notification:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in cron job:', error);
    }
});

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.audioMessage?.contextInfo) {
            cleanedMessage.audioMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.audioMessage.contextInfo.forwardingScore) {
                cleanedMessage.audioMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.documentMessage?.contextInfo) {
            cleanedMessage.documentMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.documentMessage.contextInfo.forwardingScore) {
                cleanedMessage.documentMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.protocolMessage) {
            if (cleanedMessage.protocolMessage.type === 14 || 
                cleanedMessage.protocolMessage.type === 26) {
                if (cleanedMessage.protocolMessage.historySyncNotification) {
                    const syncData = cleanedMessage.protocolMessage.historySyncNotification;
                    if (syncData.pushName) {
                        console.log('Newsletter from:', syncData.pushName);
                    }
                }
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi,
        /Broadcast:/gi,
        /Announcement:/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    cleanedText = cleanedText.trim();
    return cleanedText;
}

function replaceCaption(caption) {
    if (!caption) return caption;
    const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
        ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
            try {
                return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
            } catch (e) {
                console.error(`Invalid regex pattern: ${pattern}`, e);
                return null;
            }
        }).filter(regex => regex !== null)
        : [];
    const NEW_TEXT = process.env.NEW_TEXT || '';
    
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    
    return result;
}

function processAndCleanMessage(originalMessage) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
            const cleanedText = cleanNewsletterText(text);
            
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        delete cleanedMessage.protocolMessage;
        
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        if (cleanedMessage.extendedTextMessage) {
            cleanedMessage.extendedTextMessage.contextInfo = cleanedMessage.extendedTextMessage.contextInfo || {};
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from, userId) {
    const hasAccess = await checkUserAccess(userId);
    if (!hasAccess) {
        await sock.sendMessage(from, { 
            text: `❌ *Access Denied!*\n\nYour trail has expired or you don't have an active subscription.\n\n📌 *Subscribe Now:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nVisit our website or send payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}`
        });
        return;
    }
    await sock.sendMessage(from, { text: "🤖 Bot is Active! Love You😘" });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            let groupType = "Simple Group";
            if (group.isCommunity) {
                groupType = "Community";
            } else if (group.isCommunityAnnounce) {
                groupType = "Community Announcement";
            } else if (group.parentGroup) {
                groupType = "Subgroup";
            }
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   📝 Type: ${groupType}\n`;
            response += `   ──────────────\n\n`;
            
            groupCount++;
        }
        
        if (groupCount === 1) {
            response = "❌ No groups found. You are not in any groups.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }
        
        await sock.sendMessage(from, { text: response });
        console.log(`GJID command executed. Sent ${groupCount - 1} groups list.`);
        
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { 
            text: "❌ Error fetching groups list. Please try again later." 
        });
    }
}

async function handlePaymentCommand(sock, from, userId, text) {
    const args = text.split(' ');
    if (args.length < 2) {
        await sock.sendMessage(from, {
            text: `📌 *Payment Options:*\n\nChoose a payment method:\n1. JazzCash\n2. EasyPaisa\n3. UPaisa\n4. Rast\n\nType: !payment [method] [screenshot_url]\n\nExample: !payment jazzcash https://example.com/screenshot.jpg`
        });
        return;
    }
    
    const method = args[1].toLowerCase();
    const screenshot = args[2] || '';
    
    const validMethods = ['jazzcash', 'easypaisa', 'upaisa', 'rast'];
    if (!validMethods.includes(method)) {
        await sock.sendMessage(from, {
            text: `❌ Invalid payment method. Choose from: ${validMethods.join(', ')}`
        });
        return;
    }
    
    if (!screenshot) {
        await sock.sendMessage(from, {
            text: `❌ Please provide screenshot URL.\n\nExample: !payment ${method} https://example.com/screenshot.jpg`
        });
        return;
    }
    
    const result = await processPayment(userId, method, screenshot);
    if (result) {
        // Notify admin
        const adminMsg = `💰 *New Payment Received!*\n\nUser: ${userId}\nPhone: ${result.phoneNumber}\nMethod: ${method.toUpperCase()}\nScreenshot: ${screenshot}\n\n*Approve?*\nReply: !approve ${userId} or !reject ${userId}`;
        
        // Send to admin
        const adminSessionId = 'admin_session';
        if (sessions.has(adminSessionId)) {
            const adminSession = sessions.get(adminSessionId);
            if (adminSession.sock && adminSession.isConnected) {
                await adminSession.sock.sendMessage(ADMIN_JID, { text: adminMsg });
            }
        }
        
        await sock.sendMessage(from, {
            text: `✅ *Payment Received!*\n\nYour payment is being verified by admin.\nYou will be notified once approved.\n\nThank you for your patience! 🙏`
        });
    } else {
        await sock.sendMessage(from, {
            text: `❌ Error processing payment. Please try again later.`
        });
    }
}

async function processCommand(sock, msg, userId) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const command = text.trim().toLowerCase();
    
    try {
        if (command === '!ping') {
            await handlePingCommand(sock, from, userId);
        }
        else if (command === '!jid') {
            await handleJidCommand(sock, from);
        }
        else if (command === '!gjid') {
            await handleGjidCommand(sock, from);
        }
        else if (command.startsWith('!payment')) {
            await handlePaymentCommand(sock, from, userId, text);
        }
        else if (command.startsWith('!approve')) {
            // Admin only
            if (from === ADMIN_JID) {
                const args = text.split(' ');
                if (args.length >= 2) {
                    const targetUserId = args[1];
                    const result = await approvePayment(targetUserId);
                    if (result) {
                        await sock.sendMessage(from, {
                            text: `✅ Payment approved for ${targetUserId}\nBot will be activated now.`
                        });
                    } else {
                        await sock.sendMessage(from, {
                            text: `❌ Failed to approve payment for ${targetUserId}`
                        });
                    }
                }
            }
        }
        else if (command.startsWith('!reject')) {
            // Admin only
            if (from === ADMIN_JID) {
                const args = text.split(' ');
                if (args.length >= 2) {
                    const targetUserId = args[1];
                    const result = await rejectPayment(targetUserId);
                    if (result) {
                        await sock.sendMessage(from, {
                            text: `❌ Payment rejected for ${targetUserId}`
                        });
                    } else {
                        await sock.sendMessage(from, {
                            text: `❌ Failed to reject payment for ${targetUserId}`
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId, userId = null) {
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
        userId: userId
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
                    startSession(sessionId, userId);
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

    // AUTO FORWARD MESSAGE HANDLER
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_origin = wasi_msg.key.remoteJid;
        const userId = wasi_origin.split('@')[0];
        
        // Check if this is a user message
        if (wasi_origin.includes('@s.whatsapp.net')) {
            // Check if user has access
            const hasAccess = await checkUserAccess(userId);
            
            // If no access, send subscription message
            if (!hasAccess && !wasi_msg.key.fromMe) {
                const userInfo = await getUserPaymentInfo(userId);
                if (userInfo) {
                    const now = new Date();
                    let message = '';
                    
                    if (userInfo.trailEnd && now > userInfo.trailEnd && !userInfo.isPaid) {
                        message = `⏰ *Your free trail has expired!*\n\nPlease subscribe to continue using the bot.\n\n📌 *Subscription Price:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nTo subscribe, send payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}\n\nAfter payment, send:\n!payment [method] [screenshot_url]`;
                    } else if (userInfo.paymentExpiry && now > userInfo.paymentExpiry) {
                        message = `⏰ *Your subscription has expired!*\n\nPlease renew to continue using the bot.\n\n📌 *Renewal Price:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nTo renew, send payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}\n\nAfter payment, send:\n!payment [method] [screenshot_url]`;
                    } else {
                        message = `❌ *Access Denied!*\n\nYou don't have an active subscription.\n\n📌 *Subscribe Now:* Rs. ${SUBSCRIPTION_PRICE}/month\n\nSend payment to:\n${Object.values(PAYMENT_ACCOUNTS).map(acc => `${acc.type}: ${acc.name} - ${acc.number}`).join('\n')}\n\nAfter payment, send:\n!payment [method] [screenshot_url]`;
                    }
                    
                    try {
                        await wasi_sock.sendMessage(wasi_origin, { text: message });
                    } catch (e) {
                        console.error('Error sending access denied message:', e);
                    }
                    return;
                }
            }
        }

        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption ||
            wasi_msg.message.videoMessage?.caption ||
            wasi_msg.message.documentMessage?.caption || "";

        // COMMAND HANDLER
        if (wasi_text.startsWith('!') && wasi_origin.includes('@s.whatsapp.net')) {
            await processCommand(wasi_sock, wasi_msg, userId);
        }

        // AUTO FORWARD LOGIC (only for active users)
        if (SOURCE_JIDS.includes(wasi_origin) && !wasi_msg.key.fromMe) {
            // Check if source is allowed and user has access
            const sourceUserId = wasi_origin.split('@')[0];
            const hasAccess = await checkUserAccess(sourceUserId);
            
            if (!hasAccess) {
                console.log(`Access denied for ${sourceUserId}`);
                return;
            }
            
            try {
                let relayMsg = processAndCleanMessage(wasi_msg.message);
                
                if (!relayMsg) return;

                if (relayMsg.viewOnceMessageV2)
                    relayMsg = relayMsg.viewOnceMessageV2.message;
                if (relayMsg.viewOnceMessage)
                    relayMsg = relayMsg.viewOnceMessage.message;

                const isMedia = relayMsg.imageMessage ||
                    relayMsg.videoMessage ||
                    relayMsg.audioMessage ||
                    relayMsg.documentMessage ||
                    relayMsg.stickerMessage;

                let isEmojiOnly = false;
                if (relayMsg.conversation) {
                    const emojiRegex = /^(?:\p{Extended_Pictographic}|\s)+$/u;
                    isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                }

                if (!isMedia && !isEmojiOnly) return;

                if (relayMsg.imageMessage?.caption) {
                    relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                }
                if (relayMsg.videoMessage?.caption) {
                    relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                }
                if (relayMsg.documentMessage?.caption) {
                    relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                }

                console.log(`📦 Forwarding (cleaned) from ${wasi_origin}`);

                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            relayMsg,
                            { messageId: wasi_sock.generateMessageTag() }
                        );
                        console.log(`✅ Clean message forwarded to ${targetJid}`);
                    } catch (err) {
                        console.error(`Failed to forward to ${targetJid}:`, err.message);
                    }
                }

            } catch (err) {
                console.error('Auto Forward Error:', err.message);
            }
        }
    });
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

// API: Get payment info
wasi_app.get('/api/payment/info/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = await getUserPaymentInfo(userId);
        
        if (!user) {
            return res.json({
                success: false,
                message: 'User not found'
            });
        }
        
        const now = new Date();
        const trailRemaining = user.trailEnd ? Math.max(0, (user.trailEnd - now) / (1000 * 60 * 60)) : 0;
        const daysRemaining = user.paymentExpiry ? Math.max(0, (user.paymentExpiry - now) / (1000 * 60 * 60 * 24)) : 0;
        
        res.json({
            success: true,
            data: {
                userId: user.userId,
                phoneNumber: user.phoneNumber,
                isActive: user.isActive,
                isPaid: user.isPaid,
                trailHoursRemaining: Math.round(trailRemaining * 10) / 10,
                daysRemaining: Math.round(daysRemaining * 10) / 10,
                paymentMethod: user.paymentMethod,
                adminApproval: user.adminApproval,
                paymentExpiry: user.paymentExpiry,
                botActive: user.botActive
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Get payment accounts
wasi_app.get('/api/payment/accounts', (req, res) => {
    res.json({
        success: true,
        accounts: PAYMENT_ACCOUNTS
    });
});

// API: Submit payment (for web)
wasi_app.post('/api/payment/submit', async (req, res) => {
    try {
        const { userId, phoneNumber, method, screenshot } = req.body;
        
        if (!userId || !method || !screenshot) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }
        
        // Create or update user
        const user = await createOrUpdateUser(userId, phoneNumber);
        if (!user) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create user'
            });
        }
        
        // Process payment
        const payment = await processPayment(userId, method, screenshot);
        if (!payment) {
            return res.status(500).json({
                success: false,
                message: 'Failed to process payment'
            });
        }
        
        // Notify admin
        const adminMsg = `💰 *New Web Payment Received!*\n\nUser: ${userId}\nPhone: ${phoneNumber}\nMethod: ${method.toUpperCase()}\nScreenshot: ${screenshot}\n\n*Approve?*\nReply: !approve ${userId} or !reject ${userId}`;
        
        const adminSessionId = 'admin_session';
        if (sessions.has(adminSessionId)) {
            const adminSession = sessions.get(adminSessionId);
            if (adminSession.sock && adminSession.isConnected) {
                await adminSession.sock.sendMessage(ADMIN_JID, { text: adminMsg });
            }
        }
        
        res.json({
            success: true,
            message: 'Payment submitted successfully! Awaiting admin approval.'
        });
        
    } catch (error) {
        console.error('Error submitting payment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Admin approve payment (web)
wasi_app.post('/api/payment/approve', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'Missing userId'
            });
        }
        
        const result = await approvePayment(userId);
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Payment approved successfully! Bot activated.'
        });
        
    } catch (error) {
        console.error('Error approving payment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Admin reject payment (web)
wasi_app.post('/api/payment/reject', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'Missing userId'
            });
        }
        
        const result = await rejectPayment(userId);
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Payment rejected!'
        });
        
    } catch (error) {
        console.error('Error rejecting payment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Get status
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = isDBConnected;

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
        phoneNumber: connected ? 'Connected ✅' : '-',
        lastActive: new Date().toISOString(),
        activeSessions: Array.from(sessions.keys())
    });
});

// API: Restart bot
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
        userSessions.clear();
        
        setTimeout(() => {
            main().catch(err => console.error('Restart error:', err));
        }, 1000);
        
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Logout
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

// API: Get sessions list
wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: Health check
wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        dbConnected: isDBConnected
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid, !payment`);
        console.log(`💰 Subscription Price: Rs. ${SUBSCRIPTION_PRICE}/month`);
        console.log(`⏰ Free Trail Duration: ${FREE_TRAIL_HOURS} hours`);
        console.log(`\n📌 API Endpoints:`);
        console.log(`   GET  /api/status              - Get bot status`);
        console.log(`   GET  /api/payment/info/:id    - Get user payment info`);
        console.log(`   GET  /api/payment/accounts    - Get payment accounts`);
        console.log(`   POST /api/payment/submit      - Submit payment`);
        console.log(`   POST /api/payment/approve     - Approve payment`);
        console.log(`   POST /api/payment/reject      - Reject payment`);
        console.log(`   POST /api/restart             - Restart bot`);
        console.log(`   POST /api/logout              - Logout bot`);
        console.log(`   GET  /api/sessions            - List all sessions`);
        console.log(`   GET  /api/health              - Health check`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // 1. Connect DB if configured
    await initDB();

    // 2. Start admin session
    const adminSessionId = 'admin_session';
    await startSession(adminSessionId);

    // 3. Start user sessions for active users
    if (isDBConnected && Payment) {
        try {
            const activeUsers = await Payment.find({ botActive: true });
            for (const user of activeUsers) {
                await startUserSession(user.userId, user.phoneNumber);
            }
            console.log(`✅ Started ${activeUsers.length} user sessions`);
        } catch (error) {
            console.error('Error starting user sessions:', error);
        }
    }

    // 4. Start server
    wasi_startServer();
}

main();
