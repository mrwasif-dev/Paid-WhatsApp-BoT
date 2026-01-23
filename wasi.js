require('dotenv').config();

module.exports = {
    // ---------------------------------------------------------------------------
    // BASIC SETTINGS (All from Environment Variables)
    // ---------------------------------------------------------------------------
    botName: process.env.BOT_NAME || 'WASI BOT',
    ownerName: process.env.OWNER_NAME || 'MR WASI DEV',
    ownerNumber: process.env.OWNER_NUMBER || '',
    prefix: process.env.PREFIX || '.',
    mode: process.env.MODE || 'public',
    sessionId: process.env.SESSION_ID || 'wasi_session',
    sudo: process.env.SUDO ? process.env.SUDO.split(',').map(s => s.trim()) : [],
    mongoDbUrl: process.env.MONGODB_URI || process.env.MONGODB_URL || '',

    // ---------------------------------------------------------------------------
    // TIME & REGION
    // ---------------------------------------------------------------------------
    timeZone: process.env.TIME_ZONE || 'Asia/Karachi',

    // ---------------------------------------------------------------------------
    // VISUALS
    // ---------------------------------------------------------------------------
    fontStyle: process.env.FONT_STYLE || 'original',
    menuStyle: process.env.MENU_STYLE || 'classic',
    menuImageAsset: process.env.MENU_IMAGE_ASSET !== 'false', // Default true - use local assets
    menuImageUrl: process.env.MENU_IMAGE_URL === 'true', // Default false - must explicitly enable
    menuImage: process.env.BOT_MENU_IMAGE_URL || 'https://files.catbox.moe/ifruw6.jpg',

    // ---------------------------------------------------------------------------
    // AUTO FEATURES
    // ---------------------------------------------------------------------------
    autoReadMessages: process.env.AUTO_READ === 'true',
    autoStatusSeen: process.env.AUTO_STATUS_SEEN !== 'false', // Default true
    autoStatusReact: process.env.AUTO_STATUS_REACT !== 'false', // Default true
    autoStatusSave: process.env.AUTO_STATUS_SAVE === 'true',
    autoStatusEmojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🌈', '🔥', '✨', '💯'],
    autoStatusMessage: process.env.AUTO_STATUS_MSG === 'true',
    autoWelcome: process.env.AUTO_WELCOME === 'true',
    autoGoodbye: process.env.AUTO_GOODBYE === 'true',
    welcomeMessage: process.env.WELCOME_MSG || "Hello @user, Welcome to @group! 👋\n\n> Read the description to avoid bans.\n\nPowered by WASI BOT",
    goodbyeMessage: process.env.GOODBYE_MSG || "@user LEFT THE ROOM HAVE NICE DAY! 👋\n\nPowered by WASI BOT",

    // ---------------------------------------------------------------------------
    // PRESENCE
    // ---------------------------------------------------------------------------
    autoTyping: process.env.AUTO_TYPING === 'true',
    autoRecording: process.env.AUTO_RECORDING === 'true',
    alwaysOnline: process.env.ALWAYS_ONLINE !== 'false', // Default true

    // ---------------------------------------------------------------------------
    // AUTO REPLIES (Static fallback, can be overridden by database)
    // ---------------------------------------------------------------------------
    autoReplyEnabled: true,
    autoReplies: [
        { trigger: 'hi', reply: 'Hello! How can I help you today? 👋' },
        { trigger: 'bot', reply: 'Yes, I am here! 🤖' },
        { trigger: 'ping', reply: 'Pong! 🏓' }
    ],

    // ---------------------------------------------------------------------------
    // NEWSLETTER
    // ---------------------------------------------------------------------------
    newsletterJid: process.env.NEWSLETTER_JID || '120363419652241844@newsletter',
    newsletterName: process.env.NEWSLETTER_NAME || 'WASI-MD-V7',
};
