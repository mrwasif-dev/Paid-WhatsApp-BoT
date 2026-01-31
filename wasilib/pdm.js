const fs = require('fs');
const path = './db/pdm.json';

module.exports = {
    name: 'pdm',
    category: 'Group',
    desc: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',

    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            // DB folder check
            if (!fs.existsSync('./db')) fs.mkdirSync('./db');

            // load DB
            let pdmDB = {};
            if (fs.existsSync(path)) {
                try {
                    pdmDB = JSON.parse(fs.readFileSync(path, 'utf-8'));
                } catch {
                    pdmDB = {};
                }
            }

            const from = wasi_sender.key.remoteJid;
            const sender = wasi_sender.key.participant || from;

            // صرف گروپ میں
            if (!from.endsWith('@g.us')) return;

            // گروپ owner
            const groupMetadata = await wasi_sock.groupMetadata(from);
            const groupOwner = groupMetadata.owner;

            // bot user detect
            const botJid = (await wasi_sock.user).id || '';

            // صرف group owner یا bot
            if (sender !== groupOwner && sender !== botJid) {
                return await wasi_sock.sendMessage(from, {
                    text: '❌ صرف گروپ اونر یا بوٹ یوزر ہی اس فیچر کو آن/آف کر سکتا ہے۔'
                });
            }

            // command parse (message text)
            const text = wasi_sender.message?.conversation || '';
            const args = text.trim().split(' ');
            const option = args[1]?.toLowerCase(); // "!pdm on/off"

            if (!option || !['on','off'].includes(option)) {
                return await wasi_sock.sendMessage(from, { text: 'استعمال: !pdm on/off' });
            }

            // update DB
            pdmDB[from] = option === 'on';
            fs.writeFileSync(path, JSON.stringify(pdmDB, null, 2));

            const status = option === 'on' ? 'آن' : 'آف';
            await wasi_sock.sendMessage(from, { text: `✅ PDM فیچر اب ${status} کر دیا گیا ہے۔` });

        } catch (err) {
            console.error('PDM Error:', err);
            await wasi_sock.sendMessage(
                wasi_sender.key.remoteJid,
                { text: '❌ PDM فیچر load کرنے میں مسئلہ آ گیا۔' }
            );
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
