const fs = require('fs');
const path = './db/pdm.json'; // JSON file path

// موجودہ DB load کریں یا خالی object
let pdmDB = {};
if (fs.existsSync(path)) {
    try {
        pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch (err) {
        console.error('PDM DB load error:', err);
        pdmDB = {};
    }
}

// DB save function
function saveDB() {
    fs.writeFileSync(path, JSON.stringify(pdmDB, null, 2));
}

module.exports = {
    name: 'pdm',
    description: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',
    category: 'Group',
    aliases: ['pdm'],

    wasi_handler: async (sock, msg, args) => {
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;

        // صرف گروپ میں چیک کریں
        if (!from.endsWith('@g.us')) return;

        // گروپ metadata
        const groupMetadata = await sock.groupMetadata(from);
        const groupOwner = groupMetadata.owner;

        // auto-detect current bot user JID
        const botJid = sock.user?.id || ''; // current logged in bot

        // صرف گروپ اونر یا bot JID اجازت رکھے
        if (sender !== groupOwner && sender !== botJid) {
            return sock.sendMessage(from, { text: '❌ صرف گروپ اونر یا بوٹ یوزر ہی اس فیچر کو آن/آف کر سکتا ہے۔' });
        }

        const option = args[0]?.toLowerCase();
        if (!option || !['on', 'off'].includes(option)) {
            return sock.sendMessage(from, { text: 'استعمال: !pdm on/off' });
        }

        // DB update اور save
        pdmDB[from] = option === 'on';
        saveDB();

        const status = option === 'on' ? 'آن' : 'آف';
        return sock.sendMessage(from, { text: `✅ PDM فیچر اب ${status} کر دیا گیا ہے۔` });
    },

    // کسی بھی جگہ یہ function استعمال کر کے چیک کر سکتے ہیں کہ فیچر on ہے یا off
    isPDMEnabled: (groupId) => {
        return pdmDB[groupId] || false;
    }
};
