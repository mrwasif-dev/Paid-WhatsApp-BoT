require('dotenv').config();

module.exports = {
    // ---------------------------------------------------------------------------
    // BASIC SETTINGS (Edit these)
    // ---------------------------------------------------------------------------
    botName: process.env.BOT_NAME || 'WASI BOT',
    ownerName: 'Waseem',
    ownerNumber: process.env.OWNER_NUMBER || '263788049675', // Your WhatsApp number without + or spaces
    prefix: '.',
    mode: process.env.MODE || 'public', // public / private put public if you want to use it in public group    

    // ---------------------------------------------------------------------------
    // TIME & REGION
    // ---------------------------------------------------------------------------
    timeZone: 'Asia/Karachi',

    // ---------------------------------------------------------------------------
    // VISUALS
    // ---------------------------------------------------------------------------
    menuImage: process.env.BOT_MENU_IMAGE_URL || 'https://graph.org/file/7c6999908a8df07400d41.jpg',

    // ---------------------------------------------------------------------------
    // AUTO FEATURES (true / false)
    // ---------------------------------------------------------------------------
    autoReadMessages: false,      // Automatically mark messages as read (blue ticks)
    autoStatusSeen: true,         // Automatically view status updates and react with heart
    autoStatusReact: true,        // React with heart emoji on status
    autoStatusMessage: true,      // Send "Your status has been seen by WASI BOT" message

    // ---------------------------------------------------------------------------
    // PRESENCE / APPEARANCE (true / false)
    // ---------------------------------------------------------------------------
    autoTyping: false,            // Show "typing..." before sending messages
    autoRecording: false,         // Show "recording audio..." in chats
    alwaysOnline: true,           // Show the bot as "Online" all the time

    // ---------------------------------------------------------------------------
    // DATABASE
    // ---------------------------------------------------------------------------
    mongoDbUrl: process.env.MONGODB_URI || '',
};
