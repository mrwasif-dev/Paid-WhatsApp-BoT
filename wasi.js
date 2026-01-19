require('dotenv').config();

module.exports = {
    // ---------------------------------------------------------------------------
    // BASIC SETTINGS (Edit these)
    // ---------------------------------------------------------------------------
    botName: process.env.BOT_NAME || 'WASI BOT',
    ownerName: 'Waseem',
    ownerNumber: process.env.OWNER_NUMBER || '263788049675', // Your WhatsApp number without + or spaces
    prefix: '/',
    mode: process.env.MODE || 'public', // public / private put public if you want to use it in public group    
    sessionId: process.env.SESSION_ID || 'wasi_session', // Unique ID to separate data in MongoDB

    // -----------------------powered by mrwasi.dev----------------------------------------------------
    // TIME & REGION
    // ---------------------------------------------------------------------------
    timeZone: 'Asia/Karachi',

    // ---------------------------------------------------------------------------
    // VISUALS
    // ---------------------------------------------------------------------------
    fontStyle: process.env.FONT_STYLE || 'original', // original, typewriter, bold, italic, circle, etc.
    menuStyle: process.env.MENU_STYLE || 'classic', // classic, simple, bold, tech, aesthetic
    // ---------------------------------------------------------------------------
    menuImage: process.env.BOT_MENU_IMAGE_URL || 'https://graph.org/file/7c6999908a8df07400d41.jpg',

    // ---------------------------------------------------------------------------
    // AUTO FEATURES (true / false)
    // ---------------------------------------------------------------------------
    autoReadMessages: false,      // Automatically mark messages as read (blue ticks)
    autoStatusSeen: true,         // Automatically view status updates and react with heart
    autoStatusReact: true,        // React with heart emoji on status
    autoStatusMessage: true,      // Send "Your status has been seen by WASI BOT" message
    autoWelcome: false,           // Auto welcome new group members
    autoGoodbye: false,           // Auto goodbye left group members
    welcomeMessage: "Hello @user, Welcome to @group! 👋\n\n> Read the description to avoid bans.\n\nPowered by WASI BOT",
    goodbyeMessage: "@user LEFT THE ROOM HAVE NICE DAY! 👋\n\nPowered by WASI BOT",

    // ---------------------------------------------------------------------------
    // PRESENCE / APPEARANCE (true / false)
    // ---------------------------------------------------------------------------
    autoTyping: false,            // Show "typing..." before sending messages
    autoRecording: false,         // Show "recording audio..." in chats
    alwaysOnline: true,           // Show the bot as "Online" all the time

    // ---------------------------------------------------------------------------
    // AUTO REPLIES
    // ---------------------------------------------------------------------------
    autoReplyEnabled: true,
    autoReplies: [
        { trigger: 'hi', reply: 'Hello! How can I help you today? 👋' },
        { trigger: 'bot', reply: 'Yes, I am here! 🤖' },
        { trigger: 'ping', reply: 'Pong! 🏓' }
    ],

    // ---------------------------------------------------------------------------
    // DATABASE
    // ---------------------------------------------------------------------------
    mongoDbUrl: process.env.MONGODB_URI || '',

    // ---------------------------------------------------------------------------
    // NEWSLETTER / CHANNEL
    // ---------------------------------------------------------------------------
    newsletterJid: '120363419652241844@newsletter',
    newsletterName: 'WASI-MD-V7',
};
