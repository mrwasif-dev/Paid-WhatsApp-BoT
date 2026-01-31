const fs = require('fs');
const path = './db/pdm.json';

module.exports = {
    name: 'pdm',
    category: 'Group',
    desc: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',
    aliases: ['pdm'],

    wasi_handler: async (sock, msg, args) => {
        try {
            // ensure db folder exists
            if (!fs.existsSync('./db')) fs.mkdirSync('./db');

            // load DB
            let pdmDB = {};
            if (fs.existsSync(path)) {
                try {
                    pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
                } catch (err) {
                    console.error('❌ PDM DB load error:', err);
                    pdmDB = {};
                }
            }

            const from = msg.key.remoteJid;
            const sender = msg.key.participant || msg.key.remoteJid;

            // صرف گروپ میں
            if (!from.endsWith('@g.us')) return;

            const groupMetadata = await sock.groupMetadata(from);
            const groupOwner = groupMetadata.owner;

            // auto-detect current bot user JID safely
            let botJid = '';
            try {
                botJid = (await sock.user)?.id || '';
            } catch {
                botJid = '';
            }

            // صرف گروپ اونر یا bot user allow
            if (sender !== groupOwner && sender !== botJid) {
                return sock.sendMessage(from, { text: '❌ صرف گروپ اونر یا بوٹ یوزر ہی اس فیچر کو آن/آف کر سکتا ہے۔' });
            }

            const option = args[0]?.toLowerCase();
            if (!option || !['on', 'off'].includes(option)) {
                return sock.sendMessage(from, { text: 'استعمال: !pdm on/off' });
            }

            // update DB
            pdmDB[from] = option === 'on';
            fs.writeFileSync(path, JSON.stringify(pdmDB, null, 2));

            const status = option === 'on' ? 'آن' : 'آف';
            await sock.sendMessage(from, { text: `✅ PDM فیچر اب ${status} کر دیا گیا ہے۔` });

        } catch (err) {
            console.error('❌ PDM Handler Error:', err);
            await sock.sendMessage(msg.key.remoteJid, { text: '❌ PDM فیچر load کرنے میں مسئلہ آ گیا۔' });
        }
    },

    isPDMEnabled: (groupId) => {
        try {
            if (fs.existsSync(path)) {
                const pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
                return pdmDB[groupId] || false;
            }
            return false;
        } catch {
            return false;
        }
    }
};
