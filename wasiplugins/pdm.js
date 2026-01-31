const fs = require('fs');
const path = './db/pdm.json';

module.exports = {
    name: 'pdm',
    category: 'Group',
    desc: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',

    wasi_handler: async (sock, sender) => {
        try {
            // DB folder اور file ensure
            if (!fs.existsSync('./db')) fs.mkdirSync('./db');
            if (!fs.existsSync(path)) fs.writeFileSync(path, '{}');

            // load DB
            let pdmDB = {};
            try {
                pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
            } catch {
                pdmDB = {};
            }

            // safe checks
            if (!sender || !sender.key) return;

            const from = sender.key.remoteJid || '';
            const participant = sender.key.participant || from;

            // صرف گروپ میں
            if (!from.endsWith('@g.us')) return;

            // گروپ owner
            const groupMetadata = await sock.groupMetadata(from);
            const groupOwner = groupMetadata.owner;

            // صرف گروپ owner allow
            if (participant !== groupOwner) {
                return await sock.sendMessage(from, {
                    text: '❌ صرف گروپ اونر ہی اس فیچر کو آن/آف کر سکتا ہے۔'
                });
            }

            // message text سے command parse
            const text = sender.message?.conversation || '';
            const args = text.trim().split(' '); // "!pdm on/off"
            const option = args[1]?.toLowerCase();

            if (!option || !['on','off'].includes(option)) {
                return await sock.sendMessage(from, { text: 'استعمال: !pdm on/off' });
            }

            // DB update
            pdmDB[from] = option === 'on';
            fs.writeFileSync(path, JSON.stringify(pdmDB, null, 2));

            const status = option === 'on' ? 'آن' : 'آف';
            await sock.sendMessage(from, { text: `✅ PDM فیچر اب ${status} کر دیا گیا ہے۔` });

        } catch (err) {
            console.error('❌ PDM Handler Error:', err);
            if (sender && sender.key && sender.key.remoteJid) {
                await sock.sendMessage(sender.key.remoteJid, {
                    text: '❌ PDM فیچر load کرنے میں مسئلہ آ گیا۔'
                });
            }
        }
    },

    // کسی بھی جگہ استعمال کے لیے function
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
