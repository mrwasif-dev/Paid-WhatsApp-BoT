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

// ============================================================================
// CONFIGURATION CLASS - Better config management
// ============================================================================
class BotConfig {
    constructor() {
        this.filePath = path.join(__dirname, 'botConfig.json');
        this.config = {};
        this.loadFromEnv();
        this.loadFromFile();
    }

    loadFromEnv() {
        this.env = {
            autoStatusView: process.env.AUTO_STATUS_VIEW?.toLowerCase() === 'true' || false,
            autoStatusReact: process.env.AUTO_STATUS_REACT?.toLowerCase() === 'true' || false,
            statusReactEmoji: process.env.STATUS_REACT_EMOJI || '👍,❤️,😂,😍,👏,🔥',
            antiDeleteEnabled: process.env.ANTI_DELETE_ENABLED?.toLowerCase() === 'true' || false,
            antiDeleteStatus: process.env.ANTI_DELETE_STATUS?.toLowerCase() === 'true' || false,
            antiLinkEnabled: process.env.ANTI_LINK_ENABLED?.toLowerCase() === 'true' || false,
            antiLinkAction: process.env.ANTI_LINK_ACTION || 'delete',
            allowedLinks: process.env.ALLOWED_LINKS ? 
                process.env.ALLOWED_LINKS.split(',').map(l => l.trim()) : [],
            adminNumbers: process.env.ADMIN_NUMBERS ? 
                process.env.ADMIN_NUMBERS.split(',').map(n => n.trim()) : ['03039107958']
        };
    }

    loadFromFile() {
        try {
            if (fs.existsSync(this.filePath)) {
                const fileData = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.config = { ...this.env, ...fileData };
                console.log('✅ Bot config loaded from file');
            } else {
                this.config = { ...this.env };
            }
        } catch (error) {
            console.error('Failed to load botConfig.json:', error);
            this.config = { ...this.env };
        }
    }

    save() {
        try {
            const configToSave = {
                autoStatusView: this.config.autoStatusView,
                autoStatusReact: this.config.autoStatusReact,
                statusReactEmoji: this.config.statusReactEmoji,
                antiDeleteEnabled: this.config.antiDeleteEnabled,
                antiDeleteStatus: this.config.antiDeleteStatus,
                antiLinkEnabled: this.config.antiLinkEnabled,
                antiLinkAction: this.config.antiLinkAction,
                allowedLinks: this.config.allowedLinks,
                adminNumbers: this.config.adminNumbers,
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(this.filePath, JSON.stringify(configToSave, null, 2));
            return true;
        } catch (error) {
            console.error('Error saving bot config:', error);
            return false;
        }
    }

    get(key) {
        return this.config[key] !== undefined ? this.config[key] : this.env[key];
    }

    set(key, value) {
        this.config[key] = value;
        this.save();
    }
}

// ============================================================================
// CACHE MANAGER - Fixed memory leak
// ============================================================================
class CacheManager {
    constructor(maxSize = 200) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = 5 * 60 * 1000; // 5 minutes
    }

    set(key, value) {
        // Prevent memory leak
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        
        this.cache.set(key, {
            value: value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        
        // Check if expired
        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        
        return entry.value;
    }

    delete(key) {
        this.cache.delete(key);
    }

    size() {
        return this.cache.size;
    }

    clear() {
        this.cache.clear();
    }

    // Clean expired entries
    clean() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.ttl) {
                this.cache.delete(key);
            }
        }
    }
}

// ============================================================================
// MAIN BOT CLASS
// ============================================================================
class MuzammilBot {
    constructor() {
        // Initialize config
        this.botConfig = new BotConfig();
        
        // Initialize caches with size limits
        this.processedStatuses = new CacheManager(500);
        this.deletedMessagesCache = new CacheManager(300);
        
        // Track current emoji index
        this.currentEmojiIndex = 0;
        this.statusReactionEmojis = this.botConfig.get('statusReactEmoji')
            .split(',').map(e => e.trim());
        
        // Sessions
        this.sessions = new Map();
        
        // Express app
        this.app = express();
        this.port = process.env.PORT || 3000;
        
        // Admin numbers
        this.adminNumbers = this.botConfig.get('adminNumbers');
        
        // Setup routes
        this.setupRoutes();
        
        // Start cleanup interval
        setInterval(() => {
            this.processedStatuses.clean();
            this.deletedMessagesCache.clean();
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================
    
    isAdmin(jid) {
        const phoneNumber = jid.split('@')[0];
        return this.adminNumbers.includes(phoneNumber);
    }

    async isGroupAdmin(sock, groupJid, participantJid) {
        try {
            const groupMetadata = await sock.groupMetadata(groupJid);
            const admins = groupMetadata.participants
                .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
                .map(p => p.id);
            return admins.includes(participantJid);
        } catch (error) {
            console.error('Error checking group admin:', error);
            return false;
        }
    }

    isGroup(jid) {
        return jid.endsWith('@g.us');
    }

    extractLinks(text) {
        if (!text) return [];
        const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|org|net|gov|edu|pk|in|uk|au|ca|de|fr|jp|cn|br|ru|app|io|xyz|tech|online|site|club|pk)[^\s]*)/gi;
        return text.match(urlRegex) || [];
    }

    isLinkAllowed(link) {
        const allowedLinks = this.botConfig.get('allowedLinks');
        if (!allowedLinks || allowedLinks.length === 0) return false;
        return allowedLinks.some(allowed => link.includes(allowed));
    }

    isBotMessage(msg) {
        // Check if message is from bot itself
        return msg.key?.fromMe === true;
    }

    async sendWithRetry(sock, to, content, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                return await sock.sendMessage(to, content);
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    getMessageText(msg) {
        return msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            "";
    }

    // ========================================================================
    // STATUS HANDLER - Fixed with proper checks
    // ========================================================================
    
    async handleStatus(sock, statusMessage) {
        try {
            const autoStatusView = this.botConfig.get('autoStatusView');
            const autoStatusReact = this.botConfig.get('autoStatusReact');
            
            if (!autoStatusView && !autoStatusReact) return;
            
            const statusKey = statusMessage.key;
            const statusId = statusKey.id;
            const statusSender = statusKey.participant || statusKey.remoteJid;
            
            // Check if already processed
            if (this.processedStatuses.get(statusId)) {
                return;
            }
            
            this.processedStatuses.set(statusId, true);
            console.log(`📱 New status from: ${statusSender}`);
            
            // Auto view
            if (autoStatusView) {
                try {
                    await sock.readMessages([statusKey]);
                    console.log(`👁️ Viewed status from: ${statusSender}`);
                } catch (error) {
                    console.error('Error viewing status:', error);
                }
            }
            
            // Auto react
            if (autoStatusReact && this.statusReactionEmojis.length > 0) {
                try {
                    const selectedEmoji = this.statusReactionEmojis[this.currentEmojiIndex];
                    this.currentEmojiIndex = (this.currentEmojiIndex + 1) % this.statusReactionEmojis.length;
                    
                    await sock.sendMessage(statusSender, {
                        react: {
                            text: selectedEmoji,
                            key: statusKey
                        }
                    });
                    console.log(`❤️ Reacted to status with ${selectedEmoji}`);
                } catch (error) {
                    console.error('Error reacting:', error);
                }
            }
            
        } catch (error) {
            console.error('Error in status handler:', error);
        }
    }

    // ========================================================================
    // ANTI DELETE HANDLER - Fixed with proper message caching
    // ========================================================================
    
    cacheMessage(msg) {
        try {
            const antiDeleteEnabled = this.botConfig.get('antiDeleteEnabled');
            if (!antiDeleteEnabled) return;
            
            const msgId = msg.key.id;
            
            // Don't cache bot's own messages
            if (this.isBotMessage(msg)) return;
            
            const msgText = this.getMessageText(msg);
            
            // Only cache text messages to save memory
            if (!msgText) return;
            
            this.deletedMessagesCache.set(msgId, {
                text: msgText,
                sender: msg.key.participant || msg.key.remoteJid,
                timestamp: Date.now()
            });
            
        } catch (error) {
            console.error('Error caching message:', error);
        }
    }

    async handleAntiDelete(sock, msg) {
        try {
            const antiDeleteEnabled = this.botConfig.get('antiDeleteEnabled');
            if (!antiDeleteEnabled) return;
            
            // Check for deleted messages
            if (msg.message?.protocolMessage?.type === 0) { // Revoke/Delete
                const protocolMsg = msg.message.protocolMessage;
                const deletedMsgId = protocolMsg.key.id;
                
                // Get cached message
                const cachedMsg = this.deletedMessagesCache.get(deletedMsgId);
                if (cachedMsg) {
                    const deletedBy = msg.key.participant || msg.key.remoteJid;
                    const deletedByName = msg.pushName || 'Unknown';
                    
                    let caption = `🚫 *MESSAGE DELETED*\n\n`;
                    caption += `• Deleted by: ${deletedByName} (${deletedBy.split('@')[0]})\n`;
                    caption += `• Time: ${new Date().toLocaleString()}\n\n`;
                    caption += `*Message Content:*\n${cachedMsg.text}`;
                    
                    await this.sendWithRetry(sock, msg.key.remoteJid, { text: caption });
                    
                    console.log(`🚫 Captured deleted message from ${deletedBy}`);
                    this.deletedMessagesCache.delete(deletedMsgId);
                }
            }
            
        } catch (error) {
            console.error('Error in anti-delete handler:', error);
        }
    }

    // ========================================================================
    // ANTI LINK HANDLER - Fixed with proper checks
    // ========================================================================
    
    async handleAntiLink(sock, msg) {
        try {
            const antiLinkEnabled = this.botConfig.get('antiLinkEnabled');
            if (!antiLinkEnabled) return;
            
            const from = msg.key.remoteJid;
            if (!this.isGroup(from)) return;
            
            // Don't process bot's own messages
            if (this.isBotMessage(msg)) return;
            
            const sender = msg.key.participant || msg.key.remoteJid;
            
            // Check if sender is admin (skip admins)
            if (await this.isGroupAdmin(sock, from, sender)) return;
            if (this.isAdmin(sender)) return;
            
            const text = this.getMessageText(msg);
            const links = this.extractLinks(text);
            
            if (links.length === 0) return;
            
            // Check if any link is not allowed
            const hasDisallowedLink = links.some(link => !this.isLinkAllowed(link));
            
            if (hasDisallowedLink) {
                console.log(`🔗 Link detected in ${from} from ${sender}: ${links.join(', ')}`);
                
                const action = this.botConfig.get('antiLinkAction');
                
                // Delete the message
                if (action === 'delete' || action === 'warn') {
                    try {
                        await sock.sendMessage(from, { delete: msg.key });
                        console.log(`🗑️ Deleted link message from ${sender}`);
                    } catch (error) {
                        console.error('Error deleting message:', error);
                    }
                }
                
                // Send warning
                if (action === 'warn' || action === 'kick') {
                    const warnMsg = `⚠️ *Anti-Link System*\n\n@${sender.split('@')[0]}, links are not allowed in this group.`;
                    await this.sendWithRetry(sock, from, { 
                        text: warnMsg,
                        mentions: [sender]
                    });
                }
                
                // Kick member
                if (action === 'kick') {
                    try {
                        await sock.groupParticipantsUpdate(from, [sender], 'remove');
                        console.log(`👢 Kicked ${sender} for sending link`);
                    } catch (error) {
                        console.error('Error kicking member:', error);
                    }
                }
            }
            
        } catch (error) {
            console.error('Error in anti-link handler:', error);
        }
    }

    // ========================================================================
    // COMMAND HANDLERS - All commands fixed
    // ========================================================================
    
    async handleMenuCommand(sock, from) {
        const menuText = `╔════════════════════╗
║   *MUZAMMIL MD BOT*   ║
╚════════════════════╝

*Bot:* Muzammil MD
*Version:* 3.0.0

╔════════════════════╗
║   *BASIC COMMANDS*   ║
╚════════════════════╝

• !ping - Check bot response
• !menu - Show this menu
• !help - Show help

╔════════════════════╗
║   *STATUS COMMANDS*   ║
╚════════════════════╝

• !status - Show settings
• !statusview on/off - Toggle auto view
• !statusreact on/off - Toggle auto react
• !setemojis 👍,❤️,😂 - Set reaction emojis

╔════════════════════╗
║  *ANTI-DELETE COMMANDS*  ║
╚════════════════════╝

• !antidelete on/off - Toggle anti-delete
• !deletedcache - Show cache size

╔════════════════════╗
║   *ANTI-LINK COMMANDS*   ║
╚════════════════════╝

• !antilink on/off - Toggle anti-link
• !antilink action delete/warn/kick - Set action
• !allowlink domain.com - Add allowed domain
• !removelink domain.com - Remove allowed domain
• !listlinks - List allowed domains

╔════════════════════╗
║   *CURRENT STATUS*   ║
╚════════════════════╝

• Status View: ${this.botConfig.get('autoStatusView') ? '✅' : '❌'}
• Status React: ${this.botConfig.get('autoStatusReact') ? '✅' : '❌'}
• Anti-Delete: ${this.botConfig.get('antiDeleteEnabled') ? '✅' : '❌'}
• Anti-Link: ${this.botConfig.get('antiLinkEnabled') ? '✅' : '❌'}
• Action: ${this.botConfig.get('antiLinkAction')}

_Muzammil MD Bot_`;

        await this.sendWithRetry(sock, from, { text: menuText });
    }

    async handleHelpCommand(sock, from) {
        const helpText = `╔════════════════════╗
║   *MUZAMMIL MD HELP*   ║
╚════════════════════╝

*BASIC COMMANDS*
!ping - Check bot
!menu - Main menu
!help - This help

*STATUS FEATURES*
!statusview on/off - Auto view status
!statusreact on/off - Auto react to status
!setemojis 👍,❤️,😂 - Set reaction emojis

*ANTI-DELETE FEATURES*
Captures deleted messages and shows who deleted
!antidelete on/off - Enable/disable

*ANTI-LINK FEATURES*
Blocks links in groups
!antilink on/off - Enable/disable
!antilink action delete/warn/kick - Set action
!allowlink domain.com - Add allowed domain
!removelink domain.com - Remove domain
!listlinks - Show allowed domains

*Note: Some commands are admin only*`;

        await this.sendWithRetry(sock, from, { text: helpText });
    }

    async handlePingCommand(sock, from) {
        await this.sendWithRetry(sock, from, { text: "❤️ Love You 😘" });
    }

    // Status Commands
    async handleStatusCommand(sock, from) {
        const statusText = `*Current Status Settings*

Auto View: ${this.botConfig.get('autoStatusView') ? '✅ ON' : '❌ OFF'}
Auto React: ${this.botConfig.get('autoStatusReact') ? '✅ ON' : '❌ OFF'}

Reaction Emojis:
${this.statusReactionEmojis.map((e, i) => `${i+1}. ${e}`).join('\n')}

Next Emoji: ${this.statusReactionEmojis[this.currentEmojiIndex]}

Processed Statuses: ${this.processedStatuses.size()}`;

        await this.sendWithRetry(sock, from, { text: statusText });
    }

    async handleStatusViewCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { 
                text: `Auto Status View is currently ${this.botConfig.get('autoStatusView') ? '✅ ON' : '❌ OFF'}\n\nUse: !statusview on/off` 
            });
            return;
        }
        
        const option = args[0].toLowerCase();
        
        if (option === 'on') {
            this.botConfig.set('autoStatusView', true);
            await this.sendWithRetry(sock, from, { text: "✅ Auto Status View is now *ON*" });
        } else if (option === 'off') {
            this.botConfig.set('autoStatusView', false);
            await this.sendWithRetry(sock, from, { text: "❌ Auto Status View is now *OFF*" });
        } else {
            await this.sendWithRetry(sock, from, { text: "Usage: !statusview on/off" });
        }
    }

    async handleStatusReactCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { 
                text: `Auto Status React is currently ${this.botConfig.get('autoStatusReact') ? '✅ ON' : '❌ OFF'}\n\nUse: !statusreact on/off` 
            });
            return;
        }
        
        const option = args[0].toLowerCase();
        
        if (option === 'on') {
            this.botConfig.set('autoStatusReact', true);
            await this.sendWithRetry(sock, from, { text: "✅ Auto Status React is now *ON*" });
        } else if (option === 'off') {
            this.botConfig.set('autoStatusReact', false);
            await this.sendWithRetry(sock, from, { text: "❌ Auto Status React is now *OFF*" });
        } else {
            await this.sendWithRetry(sock, from, { text: "Usage: !statusreact on/off" });
        }
    }

    async handleSetEmojisCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { 
                text: `Current emojis: ${this.statusReactionEmojis.join(' ')}\n\nUsage: !setemojis 👍,❤️,😂` 
            });
            return;
        }
        
        const emojiString = args.join(' ');
        const newEmojis = emojiString.split(',').map(e => e.trim());
        
        if (newEmojis.length === 0) {
            await this.sendWithRetry(sock, from, { text: "❌ No emojis provided!" });
            return;
        }
        
        this.statusReactionEmojis = newEmojis;
        this.currentEmojiIndex = 0;
        this.botConfig.set('statusReactEmoji', newEmojis.join(','));
        
        await this.sendWithRetry(sock, from, { 
            text: `✅ Reaction emojis updated to: ${newEmojis.join(' ')}` 
        });
    }

    // Anti-Delete Commands
    async handleAntiDeleteCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { 
                text: `Anti-Delete is currently ${this.botConfig.get('antiDeleteEnabled') ? '✅ ON' : '❌ OFF'}\n\nUse: !antidelete on/off` 
            });
            return;
        }
        
        const option = args[0].toLowerCase();
        
        if (option === 'on') {
            this.botConfig.set('antiDeleteEnabled', true);
            await this.sendWithRetry(sock, from, { text: "✅ Anti-Delete is now *ON*" });
        } else if (option === 'off') {
            this.botConfig.set('antiDeleteEnabled', false);
            await this.sendWithRetry(sock, from, { text: "❌ Anti-Delete is now *OFF*" });
        } else {
            await this.sendWithRetry(sock, from, { text: "Usage: !antidelete on/off" });
        }
    }

    async handleDeletedCacheCommand(sock, from, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        await this.sendWithRetry(sock, from, { 
            text: `📦 Deleted Messages Cache: ${this.deletedMessagesCache.size()} messages` 
        });
    }

    // Anti-Link Commands
    async handleAntiLinkCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { 
                text: `Anti-Link is currently ${this.botConfig.get('antiLinkEnabled') ? '✅ ON' : '❌ OFF'}\nAction: ${this.botConfig.get('antiLinkAction')}\n\nUse: !antilink on/off` 
            });
            return;
        }
        
        const option = args[0].toLowerCase();
        
        if (option === 'on') {
            this.botConfig.set('antiLinkEnabled', true);
            await this.sendWithRetry(sock, from, { text: "✅ Anti-Link is now *ON*" });
        } else if (option === 'off') {
            this.botConfig.set('antiLinkEnabled', false);
            await this.sendWithRetry(sock, from, { text: "❌ Anti-Link is now *OFF*" });
        } else if (option === 'action' && args[1]) {
            const action = args[1].toLowerCase();
            if (['delete', 'warn', 'kick'].includes(action)) {
                this.botConfig.set('antiLinkAction', action);
                await this.sendWithRetry(sock, from, { text: `✅ Anti-Link action set to: *${action}*` });
            } else {
                await this.sendWithRetry(sock, from, { text: "❌ Invalid action! Use: delete/warn/kick" });
            }
        } else {
            await this.sendWithRetry(sock, from, { text: "Usage: !antilink on/off\n!antilink action delete/warn/kick" });
        }
    }

    async handleAllowLinkCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { text: `Usage: !allowlink domain.com` });
            return;
        }
        
        const domain = args[0].toLowerCase();
        const allowedLinks = this.botConfig.get('allowedLinks') || [];
        
        if (allowedLinks.includes(domain)) {
            await this.sendWithRetry(sock, from, { text: `❌ ${domain} is already allowed` });
            return;
        }
        
        allowedLinks.push(domain);
        this.botConfig.set('allowedLinks', allowedLinks);
        await this.sendWithRetry(sock, from, { text: `✅ Added ${domain} to allowed links` });
    }

    async handleRemoveLinkCommand(sock, from, args, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        if (!args || args.length === 0) {
            await this.sendWithRetry(sock, from, { text: `Usage: !removelink domain.com` });
            return;
        }
        
        const domain = args[0].toLowerCase();
        const allowedLinks = this.botConfig.get('allowedLinks') || [];
        const index = allowedLinks.indexOf(domain);
        
        if (index === -1) {
            await this.sendWithRetry(sock, from, { text: `❌ ${domain} not found in allowed links` });
            return;
        }
        
        allowedLinks.splice(index, 1);
        this.botConfig.set('allowedLinks', allowedLinks);
        await this.sendWithRetry(sock, from, { text: `✅ Removed ${domain} from allowed links` });
    }

    async handleListLinksCommand(sock, from, sender) {
        if (!this.isAdmin(sender)) {
            await this.sendWithRetry(sock, from, { text: "❌ Admin only command!" });
            return;
        }
        
        const allowedLinks = this.botConfig.get('allowedLinks') || [];
        
        if (allowedLinks.length === 0) {
            await this.sendWithRetry(sock, from, { text: "📋 No allowed links configured" });
            return;
        }
        
        let response = "📋 *Allowed Links:*\n\n";
        allowedLinks.forEach((link, index) => {
            response += `${index + 1}. ${link}\n`;
        });
        
        await this.sendWithRetry(sock, from, { text: response });
    }

    // ========================================================================
    // COMMAND PROCESSOR - Fixed with better handling
    // ========================================================================
    
    async processCommand(sock, msg) {
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const text = this.getMessageText(msg);
        
        if (!text || !text.startsWith('!')) return;
        
        // Don't process bot's own commands
        if (this.isBotMessage(msg)) return;
        
        const commandParts = text.trim().toLowerCase().split(/\s+/);
        const command = commandParts[0];
        const args = commandParts.slice(1);
        
        try {
            switch (command) {
                case '!ping': 
                    await this.handlePingCommand(sock, from); 
                    break;
                case '!menu': 
                    await this.handleMenuCommand(sock, from); 
                    break;
                case '!help': 
                    await this.handleHelpCommand(sock, from); 
                    break;
                
                // Status commands
                case '!status': 
                    await this.handleStatusCommand(sock, from); 
                    break;
                case '!statusview': 
                    await this.handleStatusViewCommand(sock, from, args, sender); 
                    break;
                case '!statusreact': 
                    await this.handleStatusReactCommand(sock, from, args, sender); 
                    break;
                case '!setemojis': 
                    await this.handleSetEmojisCommand(sock, from, args, sender); 
                    break;
                
                // Anti-Delete commands
                case '!antidelete': 
                    await this.handleAntiDeleteCommand(sock, from, args, sender); 
                    break;
                case '!deletedcache': 
                    await this.handleDeletedCacheCommand(sock, from, sender); 
                    break;
                
                // Anti-Link commands
                case '!antilink': 
                    await this.handleAntiLinkCommand(sock, from, args, sender); 
                    break;
                case '!allowlink': 
                    await this.handleAllowLinkCommand(sock, from, args, sender); 
                    break;
                case '!removelink': 
                    await this.handleRemoveLinkCommand(sock, from, args, sender); 
                    break;
                case '!listlinks': 
                    await this.handleListLinksCommand(sock, from, sender); 
                    break;
                
                default: 
                    break;
            }
        } catch (error) {
            console.error('Command execution error:', error);
            await this.sendWithRetry(sock, from, { 
                text: "❌ Error executing command. Please try again." 
            });
        }
    }

    // ========================================================================
    // SESSION MANAGEMENT - Fixed with better connection handling
    // ========================================================================
    
    async startSession(sessionId) {
        // Check if session already exists and is connected
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.isConnected && existing.sock) {
                console.log(`📡 Session ${sessionId} already connected`);
                return;
            }
            if (existing.sock) {
                try {
                    existing.sock.ev.removeAllListeners('connection.update');
                    existing.sock.end(undefined);
                } catch (e) {}
                this.sessions.delete(sessionId);
            }
        }

        console.log(`🚀 Starting session: ${sessionId}`);

        const sessionState = { 
            sock: null, 
            isConnected: false, 
            qr: null,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5
        };
        this.sessions.set(sessionId, sessionState);

        try {
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
                    
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 440) {
                        console.log(`🚫 Session ${sessionId} logged out`);
                        this.sessions.delete(sessionId);
                        await wasi_clearSession(sessionId);
                    } else if (sessionState.reconnectAttempts < sessionState.maxReconnectAttempts) {
                        sessionState.reconnectAttempts++;
                        console.log(`🔄 Reconnecting ${sessionId} (attempt ${sessionState.reconnectAttempts})`);
                        setTimeout(() => this.startSession(sessionId), 3000 * sessionState.reconnectAttempts);
                    } else {
                        console.log(`❌ Failed to reconnect ${sessionId} after ${sessionState.maxReconnectAttempts} attempts`);
                    }
                } else if (connection === 'open') {
                    sessionState.isConnected = true;
                    sessionState.qr = null;
                    sessionState.reconnectAttempts = 0;
                    console.log(`✅ ${sessionId}: Connected successfully`);
                    this.logStatus();
                }
            });

            wasi_sock.ev.on('creds.update', saveCreds);

            // Message Handler with proper error handling
            wasi_sock.ev.on('messages.upsert', async (wasi_m) => {
                try {
                    const wasi_msg = wasi_m.messages[0];
                    if (!wasi_msg.message) return;

                    // Cache messages for anti-delete
                    this.cacheMessage(wasi_msg);

                    // Handle status messages
                    if (wasi_msg.key.remoteJid === 'status@broadcast') {
                        await this.handleStatus(wasi_sock, wasi_msg);
                    }

                    // Handle anti-delete
                    await this.handleAntiDelete(wasi_sock, wasi_msg);

                    // Handle anti-link
                    await this.handleAntiLink(wasi_sock, wasi_msg);

                    // Handle commands
                    const text = this.getMessageText(wasi_msg);
                    if (text.startsWith('!')) {
                        await this.processCommand(wasi_sock, wasi_msg);
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            });

        } catch (error) {
            console.error(`Error starting session ${sessionId}:`, error);
        }
    }

    logStatus() {
        console.log(`\n📱 STATUS FEATURES:`);
        console.log(`   View: ${this.botConfig.get('autoStatusView') ? 'ON' : 'OFF'}`);
        console.log(`   React: ${this.botConfig.get('autoStatusReact') ? 'ON' : 'OFF'}`);
        console.log(`   Emojis: ${this.statusReactionEmojis.join(' ')}`);
        console.log(`\n🛡️ ANTI-DELETE: ${this.botConfig.get('antiDeleteEnabled') ? 'ON' : 'OFF'}`);
        console.log(`\n🔗 ANTI-LINK: ${this.botConfig.get('antiLinkEnabled') ? 'ON' : 'OFF'}`);
        console.log(`   Action: ${this.botConfig.get('antiLinkAction')}`);
        console.log(`   Allowed: ${this.botConfig.get('allowedLinks').join(', ') || 'None'}`);
    }

    // ========================================================================
    // ROUTES
    // ========================================================================
    
    setupRoutes() {
        this.app.get('/api/status', async (req, res) => {
            try {
                const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
                const session = this.sessions.get(sessionId);

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
                    success: true,
                    sessionId,
                    connected,
                    qr: qrDataUrl,
                    activeSessions: Array.from(this.sessions.keys()),
                    admins: this.adminNumbers,
                    features: {
                        status: {
                            view: this.botConfig.get('autoStatusView'),
                            react: this.botConfig.get('autoStatusReact'),
                            emojis: this.statusReactionEmojis
                        },
                        antiDelete: {
                            enabled: this.botConfig.get('antiDeleteEnabled'),
                            cacheSize: this.deletedMessagesCache.size()
                        },
                        antiLink: {
                            enabled: this.botConfig.get('antiLinkEnabled'),
                            action: this.botConfig.get('antiLinkAction'),
                            allowedLinks: this.botConfig.get('allowedLinks')
                        }
                    }
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.get('/', (req, res) => {
            try {
                res.sendFile(path.join(__dirname, 'public', 'index.html'));
            } catch (error) {
                res.send('Muzammil MD Bot is running!');
            }
        });

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });
    }

    // ========================================================================
    // SERVER START
    // ========================================================================
    
    startServer() {
        this.app.listen(this.port, () => {
            console.log(`\n🌐 Server running on port ${this.port}`);
            console.log(`🤖 Bot Name: Muzammil MD`);
            console.log(`👑 Admins: ${this.adminNumbers.join(', ')}`);
            this.logStatus();
            console.log(`\n📋 Commands: !menu for all commands\n`);
        });
    }

    // ========================================================================
    // MAIN
    // ========================================================================
    
    async main() {
        try {
            // Connect to database if configured
            if (config.mongoDbUrl) {
                const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
                if (dbResult) console.log('✅ Database connected');
            }

            const sessionId = config.sessionId || 'wasi_session';
            await this.startSession(sessionId);
            this.startServer();

            // Graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down gracefully...');
                process.exit(0);
            });

        } catch (error) {
            console.error('Fatal error:', error);
            process.exit(1);
        }
    }
}

// ============================================================================
// START THE BOT
// ============================================================================

const bot = new MuzammilBot();
bot.main();
