require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    useMultiFileAuthState,
    makeWASocket,
    Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');
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
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();
const qrTimeouts = new Map();
const keepAliveIntervals = new Map();

// Status tracking
const statusTracker = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));

// -----------------------------------------------------------------------------
// STATUS MANAGEMENT SYSTEM
// -----------------------------------------------------------------------------

const STATUS_CONFIG = {
    // Auto-reply settings
    autoReply: {
        enabled: true,
        messages: {
            view: "✅ Status viewed!",
            reply: "💬 Status replied!",
            react: "❤️ Status reacted!"
        }
    },
    // Auto-react settings
    autoReact: {
        enabled: true,
        emojis: ['❤️', '🔥', '👏', '✨', '🌟', '💯', '😍', '🎉', '🙌', '💪']
    },
    // Auto-reply to status replies
    autoReplyToStatusReply: {
        enabled: true,
        message: "📨 Thanks for your reply to my status!"
    }
};

// Status message types
const STATUS_TYPES = {
    IMAGE: 'imageMessage',
    VIDEO: 'videoMessage',
    TEXT: 'conversation',
    AUDIO: 'audioMessage',
    DOCUMENT: 'documentMessage'
};

// Status tracking class
class StatusTracker {
    constructor() {
        this.statuses = new Map();
        this.views = new Map();
        this.reactions = new Map();
        this.replies = new Map();
    }

    trackStatus(statusId, from, type, caption = '') {
        if (!this.statuses.has(statusId)) {
            this.statuses.set(statusId, {
                id: statusId,
                from: from,
                type: type,
                caption: caption,
                timestamp: Date.now(),
                views: [],
                reactions: [],
                replies: [],
                viewedCount: 0,
                repliedCount: 0,
                reactedCount: 0
            });
        }
        return this.statuses.get(statusId);
    }

    addView(statusId, viewerJid, viewerName = 'Unknown') {
        if (this.statuses.has(statusId)) {
            const status = this.statuses.get(statusId);
            if (!status.views.some(v => v.jid === viewerJid)) {
                status.views.push({
                    jid: viewerJid,
                    name: viewerName,
                    timestamp: Date.now()
                });
                status.viewedCount = status.views.length;
                return true;
            }
        }
        return false;
    }

    addReaction(statusId, reactorJid, emoji, reactorName = 'Unknown') {
        if (this.statuses.has(statusId)) {
            const status = this.statuses.get(statusId);
            // Remove existing reaction from same user
            status.reactions = status.reactions.filter(r => r.jid !== reactorJid);
            status.reactions.push({
                jid: reactorJid,
                name: reactorName,
                emoji: emoji,
                timestamp: Date.now()
            });
            status.reactedCount = status.reactions.length;
            return true;
        }
        return false;
    }

    addReply(statusId, replierJid, replyText, replierName = 'Unknown') {
        if (this.statuses.has(statusId)) {
            const status = this.statuses.get(statusId);
            status.replies.push({
                jid: replierJid,
                name: replierName,
                text: replyText,
                timestamp: Date.now()
            });
            status.repliedCount = status.replies.length;
            return true;
        }
        return false;
    }

    getStatusStats(statusId) {
        if (this.statuses.has(statusId)) {
            const status = this.statuses.get(statusId);
            return {
                id: status.id,
                from: status.from,
                type: status.type,
                caption: status.caption,
                timestamp: status.timestamp,
                views: status.views,
                reactions: status.reactions,
                replies: status.replies,
                viewedCount: status.viewedCount,
                reactedCount: status.reactedCount,
                repliedCount: status.repliedCount,
                totalEngagement: status.viewedCount + status.reactedCount + status.repliedCount,
                age: Math.floor((Date.now() - status.timestamp) / 1000 / 60) // minutes ago
            };
        }
        return null;
    }

    getAllStatusStats() {
        const stats = [];
        for (const [id, status] of this.statuses) {
            stats.push(this.getStatusStats(id));
        }
        return stats.sort((a, b) => b.timestamp - a.timestamp);
    }

    getDailyStats() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTimestamp = today.getTime();

        let totalStatuses = 0;
        let totalViews = 0;
        let totalReactions = 0;
        let totalReplies = 0;

        for (const [id, status] of this.statuses) {
            if (status.timestamp >= todayTimestamp) {
                totalStatuses++;
                totalViews += status.viewedCount;
                totalReactions += status.reactedCount;
                totalReplies += status.repliedCount;
            }
        }

        return {
            date: today.toISOString().split('T')[0],
            totalStatuses,
            totalViews,
            totalReactions,
            totalReplies,
            totalEngagement: totalViews + totalReactions + totalReplies
        };
    }
}

// Initialize status tracker
const statusTrackerInstance = new StatusTracker();

// Helper: Get contact name
async function getContactName(sock, jid) {
    try {
        const contact = await sock.contacts[jid];
        if (contact) {
            return contact.notify || contact.name || jid.split('@')[0];
        }
        return jid.split('@')[0];
    } catch (e) {
        return jid.split('@')[0];
    }
}

// Helper: Send auto-reply
async function sendAutoReply(sock, to, message) {
    try {
        await sock.sendMessage(to, { text: message });
        return true;
    } catch (e) {
        console.error('Auto-reply error:', e);
        return false;
    }
}

// Helper: Send auto-reaction
async function sendAutoReaction(sock, to, messageId, emoji) {
    try {
        await sock.sendMessage(to, {
            react: {
                text: emoji,
                key: {
                    remoteJid: to,
                    fromMe: false,
                    id: messageId,
                    participant: to
                }
            }
        });
        return true;
    } catch (e) {
        console.error('Auto-reaction error:', e);
        return false;
    }
}

// Helper: Get random emoji
function getRandomEmoji() {
    const emojis = STATUS_CONFIG.autoReact.emojis;
    return emojis[Math.floor(Math.random() * emojis.length)];
}

// -----------------------------------------------------------------------------
// STATUS HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handleStatusView(sock, statusId, from, statusData) {
    try {
        const name = await getContactName(sock, from);
        const tracked = statusTrackerInstance.trackStatus(
            statusId,
            statusData.from || from,
            statusData.type || 'unknown',
            statusData.caption || ''
        );
        
        const viewed = statusTrackerInstance.addView(statusId, from, name);
        
        if (viewed) {
            console.log(`👁️ ${name} viewed status ${statusId}`);
            
            // Auto-reply on view if enabled
            if (STATUS_CONFIG.autoReply.enabled) {
                await sendAutoReply(sock, from, STATUS_CONFIG.autoReply.messages.view);
            }
        }
        
        return tracked;
    } catch (error) {
        console.error('Status view handler error:', error);
    }
}

async function handleStatusReaction(sock, statusId, from, emoji, statusData) {
    try {
        const name = await getContactName(sock, from);
        const tracked = statusTrackerInstance.trackStatus(
            statusId,
            statusData.from || from,
            statusData.type || 'unknown',
            statusData.caption || ''
        );
        
        const reacted = statusTrackerInstance.addReaction(statusId, from, emoji, name);
        
        if (reacted) {
            console.log(`😊 ${name} reacted ${emoji} to status ${statusId}`);
            
            // Auto-reply on reaction if enabled
            if (STATUS_CONFIG.autoReply.enabled) {
                await sendAutoReply(sock, from, STATUS_CONFIG.autoReply.messages.react);
            }
        }
        
        return tracked;
    } catch (error) {
        console.error('Status reaction handler error:', error);
    }
}

async function handleStatusReply(sock, statusId, from, replyText, statusData) {
    try {
        const name = await getContactName(sock, from);
        const tracked = statusTrackerInstance.trackStatus(
            statusId,
            statusData.from || from,
            statusData.type || 'unknown',
            statusData.caption || ''
        );
        
        const replied = statusTrackerInstance.addReply(statusId, from, replyText, name);
        
        if (replied) {
            console.log(`💬 ${name} replied to status ${statusId}: ${replyText}`);
            
            // Auto-reply on status reply if enabled
            if (STATUS_CONFIG.autoReplyToStatusReply.enabled) {
                await sendAutoReply(sock, from, STATUS_CONFIG.autoReplyToStatusReply.message);
            }
        }
        
        return tracked;
    } catch (error) {
        console.error('Status reply handler error:', error);
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS - STATUS COMMANDS
// -----------------------------------------------------------------------------

async function handleStatusStatsCommand(sock, from) {
    try {
        const stats = statusTrackerInstance.getAllStatusStats();
        const dailyStats = statusTrackerInstance.getDailyStats();
        
        if (stats.length === 0) {
            await sock.sendMessage(from, {
                text: "📊 *Status Statistics*\n\n" +
                      "No status activity tracked yet.\n" +
                      "Share statuses and interact with others to see stats here!"
            });
            return;
        }

        let response = "📊 *📱 Status Statistics Dashboard*\n";
        response += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Daily stats
        response += "📅 *Today's Stats*\n";
        response += `   📸 Statuses: ${dailyStats.totalStatuses}\n`;
        response += `   👁️ Views: ${dailyStats.totalViews}\n`;
        response += `   ❤️ Reactions: ${dailyStats.totalReactions}\n`;
        response += `   💬 Replies: ${dailyStats.totalReplies}\n`;
        response += `   🔥 Engagement: ${dailyStats.totalEngagement}\n\n`;
        
        // Recent statuses
        response += "🔄 *Recent Status Activity*\n";
        const recent = stats.slice(0, 5);
        recent.forEach((status, index) => {
            const timeAgo = status.age < 60 ? `${status.age}m ago` : 
                           `${Math.floor(status.age/60)}h ${status.age%60}m ago`;
            response += `   ${index + 1}. ${status.type.toUpperCase()}\n`;
            response += `      👁️ ${status.viewedCount} views`;
            if (status.reactedCount > 0) response += ` | ❤️ ${status.reactedCount}`;
            if (status.repliedCount > 0) response += ` | 💬 ${status.repliedCount}`;
            response += `\n      ⏰ ${timeAgo}\n\n`;
        });
        
        response += "━━━━━━━━━━━━━━━━━━━━━━\n";
        response += `📌 Total Statuses Tracked: ${stats.length}\n`;
        response += "💡 Use !statusstats for detailed view";
        
        await sock.sendMessage(from, { text: response });
        console.log(`Status stats sent to ${from}`);
        
    } catch (error) {
        console.error('Status stats command error:', error);
        await sock.sendMessage(from, {
            text: "❌ Error fetching status statistics. Please try again."
        });
    }
}

async function handleMyStatusStatsCommand(sock, from) {
    try {
        const allStats = statusTrackerInstance.getAllStatusStats();
        const myStatuses = allStats.filter(s => s.from === from);
        
        if (myStatuses.length === 0) {
            await sock.sendMessage(from, {
                text: "📊 *My Status Stats*\n\n" +
                      "You haven't posted any statuses yet, or no one has interacted with them.\n" +
                      "Share a status to start tracking engagement!"
            });
            return;
        }

        let response = "📊 *👤 My Status Analytics*\n";
        response += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        let totalViews = 0, totalReactions = 0, totalReplies = 0;
        
        myStatuses.forEach((status, index) => {
            totalViews += status.viewedCount;
            totalReactions += status.reactedCount;
            totalReplies += status.repliedCount;
            
            const timeAgo = status.age < 60 ? `${status.age}m ago` : 
                           `${Math.floor(status.age/60)}h ${status.age%60}m ago`;
            response += `📸 Status ${index + 1}\n`;
            response += `   Type: ${status.type.toUpperCase()}\n`;
            response += `   👁️ Views: ${status.viewedCount}\n`;
            response += `   ❤️ Reactions: ${status.reactedCount}\n`;
            response += `   💬 Replies: ${status.repliedCount}\n`;
            response += `   ⏰ ${timeAgo}\n\n`;
        });
        
        response += "━━━━━━━━━━━━━━━━━━━━━━\n";
        response += `📈 Total Stats:\n`;
        response += `   👁️ Total Views: ${totalViews}\n`;
        response += `   ❤️ Total Reactions: ${totalReactions}\n`;
        response += `   💬 Total Replies: ${totalReplies}\n`;
        response += `   🔥 Total Engagement: ${totalViews + totalReactions + totalReplies}\n`;
        response += `   📊 Statuses Posted: ${myStatuses.length}\n`;
        
        await sock.sendMessage(from, { text: response });
        console.log(`My status stats sent to ${from}`);
        
    } catch (error) {
        console.error('My status stats command error:', error);
        await sock.sendMessage(from, {
            text: "❌ Error fetching your status statistics."
        });
    }
}

async function handleStatusConfigCommand(sock, from, args) {
    try {
        if (!args || args.length === 0) {
            // Show current config
            let response = "⚙️ *Status Bot Configuration*\n";
            response += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            response += `📌 Auto-Reply: ${STATUS_CONFIG.autoReply.enabled ? '✅ ON' : '❌ OFF'}\n`;
            response += `📌 Auto-Reaction: ${STATUS_CONFIG.autoReact.enabled ? '✅ ON' : '❌ OFF'}\n`;
            response += `📌 Reply to Status Replies: ${STATUS_CONFIG.autoReplyToStatusReply.enabled ? '✅ ON' : '❌ OFF'}\n\n`;
            response += `🔧 Commands:\n`;
            response += `   !status config autoReply on/off\n`;
            response += `   !status config autoReact on/off\n`;
            response += `   !status config replyToReply on/off\n`;
            response += `   !status config emojis [❤️,🔥,...]`;
            
            await sock.sendMessage(from, { text: response });
            return;
        }

        const setting = args[0].toLowerCase();
        const value = args[1]?.toLowerCase();

        if (setting === 'autoreply' && value) {
            STATUS_CONFIG.autoReply.enabled = value === 'on';
            await sock.sendMessage(from, {
                text: `✅ Auto-reply ${STATUS_CONFIG.autoReply.enabled ? 'enabled' : 'disabled'}`
            });
        } else if (setting === 'autoreact' && value) {
            STATUS_CONFIG.autoReact.enabled = value === 'on';
            await sock.sendMessage(from, {
                text: `✅ Auto-reaction ${STATUS_CONFIG.autoReact.enabled ? 'enabled' : 'disabled'}`
            });
        } else if (setting === 'replytoreply' && value) {
            STATUS_CONFIG.autoReplyToStatusReply.enabled = value === 'on';
            await sock.sendMessage(from, {
                text: `✅ Reply to status replies ${STATUS_CONFIG.autoReplyToStatusReply.enabled ? 'enabled' : 'disabled'}`
            });
        } else {
            await sock.sendMessage(from, {
                text: "❌ Invalid command. Use: !status config [setting] [on/off]"
            });
        }
        
    } catch (error) {
        console.error('Status config command error:', error);
        await sock.sendMessage(from, {
            text: "❌ Error updating configuration."
        });
    }
}

async function handleStatusCommand(sock, from, fullText) {
    const parts = fullText.split(' ');
    const subCommand = parts[1]?.toLowerCase();
    const args = parts.slice(2);
    
    switch(subCommand) {
        case 'stats':
            await handleStatusStatsCommand(sock, from);
            break;
        case 'mystats':
        case 'my':
            await handleMyStatusStatsCommand(sock, from);
            break;
        case 'config':
            await handleStatusConfigCommand(sock, from, args);
            break;
        default:
            await sock.sendMessage(from, {
                text: "📱 *Status Bot Commands*\n\n" +
                      "🔹 !status stats - Show global status stats\n" +
                      "🔹 !status my - Show your status stats\n" +
                      "🔹 !status config - Configure bot settings\n\n" +
                      "💡 The bot automatically tracks and responds to statuses!"
            });
    }
}

// -----------------------------------------------------------------------------
// KEEP-ALIVE MECHANISM
// -----------------------------------------------------------------------------
function startKeepAlive(sessionId, sock) {
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }
    
    console.log(`🔄 Starting keep-alive for session: ${sessionId}`);
    
    const interval = setInterval(async () => {
        try {
            const session = sessions.get(sessionId);
            if (!session || !session.isConnected || !session.sock) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
                return;
            }
            
            await session.sock.sendPresenceAvailable();
        } catch (error) {
            if (error.message?.includes('reconnecting')) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
            }
        }
    }, 30000);
    
    keepAliveIntervals.set(sessionId, interval);
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (qrTimeouts.has(sessionId)) {
        clearTimeout(qrTimeouts.get(sessionId));
        qrTimeouts.delete(sessionId);
    }
    
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            startKeepAlive(sessionId, existing.sock);
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
        lastQRTime: null,
        isConnecting: false,
        lastConnectionTime: null,
    };
    sessions.set(sessionId, sessionState);

    try {
        const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
        sessionState.sock = wasi_sock;
        sessionState.isConnecting = true;

        wasi_sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionState.qr = qr;
                sessionState.isConnected = false;
                sessionState.lastQRTime = Date.now();
                console.log(`📱 QR generated for session: ${sessionId}`);
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                }
                
                const timeout = setTimeout(() => {
                    console.log(`⏰ QR code expired for session: ${sessionId}, regenerating...`);
                    if (!sessionState.isConnected && sessionState.sock) {
                        sessionState.sock.end(undefined);
                        setTimeout(() => {
                            startSession(sessionId);
                        }, 1000);
                    }
                }, 120000);
                
                qrTimeouts.set(sessionId, timeout);
            }

            if (connection === 'close') {
                sessionState.isConnected = false;
                sessionState.isConnecting = false;
                sessionState.lastConnectionTime = Date.now();
                
                if (keepAliveIntervals.has(sessionId)) {
                    clearInterval(keepAliveIntervals.get(sessionId));
                    keepAliveIntervals.delete(sessionId);
                }
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                const statusCode = (lastDisconnect?.error instanceof Boom) ?
                    lastDisconnect.error.output.statusCode : 500;

                const isLoggedOut = statusCode === DisconnectReason.loggedOut || 
                                   statusCode === 440 ||
                                   lastDisconnect?.error?.message?.includes('401');

                if (isLoggedOut) {
                    console.log(`❌ Session ${sessionId} logged out.`);
                    sessions.delete(sessionId);
                    await wasi_clearSession(sessionId);
                    return;
                }

                const delay = Math.min(3000 * Math.pow(1.5, sessionState.reconnectAttempts), 30000);
                sessionState.reconnectAttempts += 1;

                console.log(`Session ${sessionId}: Reconnecting in ${delay}ms (attempt ${sessionState.reconnectAttempts})`);

                setTimeout(() => {
                    if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                        startSession(sessionId);
                    }
                }, delay);
                
            } else if (connection === 'open') {
                sessionState.isConnected = true;
                sessionState.isConnecting = false;
                sessionState.qr = null;
                sessionState.reconnectAttempts = 0;
                sessionState.lastConnectionTime = Date.now();
                
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                console.log(`✅ ${sessionId}: Connected to WhatsApp`);
                startKeepAlive(sessionId, wasi_sock);
                
                try {
                    await wasi_sock.sendPresenceAvailable();
                } catch (e) {}
            }
        });

        wasi_sock.ev.on('creds.update', saveCreds);

        // ============================================================
        // MAIN STATUS HANDLER - REPLACES AUTO FORWARD
        // ============================================================
        wasi_sock.ev.on('messages.upsert', async (wasi_m) => {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg.message) return;

            const from = wasi_msg.key.remoteJid;
            const isStatus = wasi_msg.key.participant && wasi_msg.key.remoteJid === 'status@broadcast';
            const isFromMe = wasi_msg.key.fromMe;

            // Check if it's a status message
            if (isStatus) {
                const msgType = Object.keys(wasi_msg.message).find(key => 
                    ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'conversation'].includes(key)
                );

                if (!msgType) return;

                // Extract status content
                let caption = '';
                let statusId = wasi_msg.key.id;
                let fromJid = wasi_msg.key.participant || from;

                if (wasi_msg.message[msgType]?.caption) {
                    caption = wasi_msg.message[msgType].caption;
                } else if (wasi_msg.message.conversation) {
                    caption = wasi_msg.message.conversation;
                }

                // Process based on message type
                if (wasi_msg.message.protocolMessage) {
                    // Handle status view receipts
                    if (wasi_msg.message.protocolMessage.type === 'STATUS_PROTOCOL_MESSAGE') {
                        // Status view tracking
                    }
                    return;
                }

                // Check for status reactions
                if (wasi_msg.message.reactionMessage) {
                    const reaction = wasi_msg.message.reactionMessage;
                    const reactedStatusId = reaction.key.id;
                    const emoji = reaction.text;
                    
                    // Track reaction
                    await handleStatusReaction(
                        wasi_sock, 
                        reactedStatusId, 
                        from, 
                        emoji,
                        { from: reaction.key.participant, type: 'reaction' }
                    );
                    return;
                }

                // Check for status replies
                if (wasi_msg.message.extendedTextMessage) {
                    const replyText = wasi_msg.message.extendedTextMessage.text;
                    const quotedMsg = wasi_msg.message.extendedTextMessage.contextInfo?.quotedMessage;
                    
                    if (quotedMsg) {
                        // This is a reply to a status
                        const statusId = wasi_msg.message.extendedTextMessage.contextInfo.stanzaId;
                        await handleStatusReply(
                            wasi_sock,
                            statusId,
                            from,
                            replyText,
                            { from: fromJid, type: 'reply', caption: caption }
                        );
                    }
                    return;
                }

                // Regular status (non-reply, non-reaction)
                if (!isFromMe) {
                    await handleStatusView(
                        wasi_sock,
                        statusId,
                        from,
                        { from: fromJid, type: msgType, caption: caption }
                    );

                    // Auto-react to status if enabled
                    if (STATUS_CONFIG.autoReact.enabled) {
                        const emoji = getRandomEmoji();
                        await sendAutoReaction(wasi_sock, from, statusId, emoji);
                        console.log(`🤖 Auto-reacted ${emoji} to status from ${from}`);
                    }

                    // Send auto-reply for status view if enabled
                    if (STATUS_CONFIG.autoReply.enabled) {
                        await sendAutoReply(wasi_sock, from, STATUS_CONFIG.autoReply.messages.view);
                    }
                }

                return;
            }

            // COMMAND HANDLER for non-status messages
            const text = wasi_msg.message.conversation ||
                wasi_msg.message.extendedTextMessage?.text ||
                wasi_msg.message.imageMessage?.caption ||
                wasi_msg.message.videoMessage?.caption ||
                "";

            if (text && text.startsWith('!')) {
                const fullText = text.trim();
                const command = fullText.split(' ')[0].toLowerCase();

                try {
                    if (command === '!status') {
                        await handleStatusCommand(wasi_sock, from, fullText);
                    } else if (command === '!ping') {
                        await wasi_sock.sendMessage(from, { text: "🏓 Pong! Status bot is alive!" });
                    } else if (command === '!jid') {
                        await wasi_sock.sendMessage(from, { text: `${from}` });
                    }
                } catch (error) {
                    console.error('Command error:', error);
                }
            }
        });

        wasi_sock.ev.on('error', (error) => {
            console.error(`Socket error for session ${sessionId}:`, error);
        });

    } catch (error) {
        console.error(`Failed to start session ${sessionId}:`, error);
        setTimeout(() => {
            if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                startSession(sessionId);
            }
        }, 5000);
    }
}

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

// API: GET STATUS
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
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
            } catch (e) {}
        }
    }

    const dailyStats = statusTrackerInstance.getDailyStats();
    const totalStatuses = statusTrackerInstance.getAllStatusStats().length;

    res.json({
        sessionId,
        connected,
        isConnecting: session?.isConnecting || false,
        qr: qrDataUrl,
        qrAvailable: !!session?.qr,
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        phoneNumber: connected ? 'Connected ✅' : (session?.isConnecting ? 'Connecting...' : 'Disconnected'),
        lastActive: new Date().toISOString(),
        keepAliveActive: keepAliveIntervals.has(sessionId),
        statusStats: {
            totalStatusesTracked: totalStatuses,
            todayViews: dailyStats.totalViews,
            todayReactions: dailyStats.totalReactions,
            todayReplies: dailyStats.totalReplies,
            todayEngagement: dailyStats.totalEngagement
        },
        activeSessions: Array.from(sessions.keys()).map(id => ({
            id,
            connected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            keepAlive: keepAliveIntervals.has(id)
        }))
    });
});

// API: STATUS STATISTICS
wasi_app.get('/api/status-stats', async (req, res) => {
    try {
        const allStats = statusTrackerInstance.getAllStatusStats();
        const dailyStats = statusTrackerInstance.getDailyStats();
        
        res.json({
            success: true,
            dailyStats,
            allStatuses: allStats,
            totalStatuses: allStats.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: GENERATE NEW QR
wasi_app.post('/api/generate-qr', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        if (session && session.sock) {
            session.sock.end(undefined);
            setTimeout(() => {
                startSession(sessionId);
            }, 1000);
            res.json({ success: true, message: 'Generating new QR code...' });
        } else {
            startSession(sessionId);
            res.json({ success: true, message: 'Starting session with new QR...' });
        }
    } catch (error) {
        console.error('Generate QR error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: RESTART BOT
wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        
        for (const [sessionId, interval] of keepAliveIntervals) {
            clearInterval(interval);
        }
        keepAliveIntervals.clear();
        
        for (const [sessionId, timeout] of qrTimeouts) {
            clearTimeout(timeout);
        }
        qrTimeouts.clear();
        
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

// API: LOGOUT
wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        if (qrTimeouts.has(sessionId)) {
            clearTimeout(qrTimeouts.get(sessionId));
            qrTimeouts.delete(sessionId);
        }
        
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

// API: GET SESSIONS LIST
wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            isConnecting: sessions.get(id)?.isConnecting || false,
            keepAliveActive: keepAliveIntervals.has(id)
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length,
            activeKeepAlives: keepAliveIntervals.size
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: HEALTH CHECK
wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        qrTimeouts: qrTimeouts.size,
        keepAliveCount: keepAliveIntervals.size,
        statusesTracked: statusTrackerInstance.getAllStatusStats().length
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📱 Status Bot System`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📌 Features:`);
        console.log(`   ✅ Auto-view statuses`);
        console.log(`   ✅ Auto-react to statuses`);
        console.log(`   ✅ Auto-reply to statuses`);
        console.log(`   ✅ Track status views, reactions & replies`);
        console.log(`   ✅ Status analytics & statistics`);
        console.log(`   ✅ Real-time engagement tracking`);
        console.log(`\n🤖 Bot Commands:`);
        console.log(`   !status - Show status commands`);
        console.log(`   !status stats - Global status stats`);
        console.log(`   !status my - Your status stats`);
        console.log(`   !status config - Configure auto-features`);
        console.log(`   !ping - Check if bot is alive`);
        console.log(`   !jid - Show your JID`);
        console.log(`\n📡 API Endpoints:`);
        console.log(`   GET  /api/status       - Get bot status`);
        console.log(`   GET  /api/status-stats - Get status statistics`);
        console.log(`   POST /api/generate-qr  - Generate new QR code`);
        console.log(`   POST /api/restart      - Restart bot`);
        console.log(`   POST /api/logout       - Logout bot`);
        console.log(`   GET  /api/sessions     - List all sessions`);
        console.log(`   GET  /api/health       - Health check`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

main();
