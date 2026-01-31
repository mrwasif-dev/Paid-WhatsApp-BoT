module.exports = {
    name: 'pdm',
    category: 'Group',
    desc: 'گروپ میں ایڈمن promote/demote الرٹ فیچر کو آن/آف کریں',

    wasi_handler: async (wasi_sock, wasi_sender) => {
        try {
            const from = wasi_sender.key.remoteJid;
            const sender = wasi_sender.key.participant || from;

            // صرف گروپ میں
            if (!from.endsWith('@g.us')) return;

            // گروپ metadata
            const groupMetadata = await wasi_sock.groupMetadata(from);
            const groupOwner = groupMetadata.owner;

            // صرف گروپ اونر allow
            if (sender !== groupOwner) {
                return await wasi_sock.sendMessage(from, {
                    text: '❌ صرف گروپ اونر ہی اس فیچر کو آن/آف کر سکتا ہے۔'
                });
            }

            // message text سے کمانڈ parse
            const text = wasi_sender.message?.conversation || '';
            const args = text.trim().split(' '); // "!pdm on/off"
            const option = args[1]?.toLowerCase();

            if (!option || !['on','off'].includes(option)) {
                return await wasi_sock.sendMessage(from, { text: 'استعمال: !pdm on/off' });
            }

            const status = option === 'on' ? 'آن' : 'آف';
            await wasi_sock.sendMessage(from, { text: `✅ PDM فیچر اب ${status} کر دیا گیا ہے۔` });

        } catch (err) {
            console.error('❌ PDM Handler Error:', err);
            await wasi_sock.sendMessage(
                wasi_sender.key.remoteJid,
                { text: '❌ PDM فیچر load کرنے میں مسئلہ آ گیا۔' }
            );
        }
    }
};
