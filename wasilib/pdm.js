const fs = require('fs');
const path = './db/pdm.json';

// ensure db folder exists
if (!fs.existsSync('./db')) fs.mkdirSync('./db');

let pdmDB = {};
if (fs.existsSync(path)) {
    try {
        pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch (err) {
        console.error('❌ PDM DB load error:', err);
        pdmDB = {};
    }
}

// Save DB function
function saveDB() {
    fs.writeFileSync(path, JSON.stringify(pdmDB, null, 2));
}

module.exports = {
    name: 'pdm',
    description: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',
    category: 'Group',
    aliases: ['pdm'],

    wasi_handler: async (sock, msg, args) => {
        try {
            const from = msg.key.remoteJid;
            const sender = msg.key.participant || msg.key.remoteJid;

            // صرف گروپ میں
            if (!from.endsWith('@g.us')) return;

            // گروپ metadata
            const groupMetadata = await sock.groupMetadata(from);
            const groupOwner = groupMetadata.owner;

            // auto-detect current bot user JID
            const botJid = (await sock.user).id || '';

            // صرف گروپ اونر یا bot JID allow
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
        } catch (err) {
            console.error('❌ PDM Handler Error:', err);
        }
    },

    // Check if PDM enabled for a group
    isPDMEnabled: (groupId) => {
        return pdmDB[groupId] || false;
    }
};
