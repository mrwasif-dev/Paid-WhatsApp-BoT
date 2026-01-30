const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'autoforward',
    description: 'Auto-forward ہر آنے والے میسج کو اس گروپ سے سیٹ کیے گئے ٹارگٹس تک بھیج دیتا ہے',
    aliases: ['af', 'autof'],
    category: 'Group',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId } = context;

        if (!wasi_isGroup) {
            return await sock.sendMessage(from, { text: '❌ یہ کمانڈ صرف گروپس کے لیے ہے!' });
        }

        if (!wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
            return await sock.sendMessage(from, { text: '❌ آپ کو یہ کمانڈ استعمال کرنے کے لیے ایڈمن ہونا ضروری ہے۔' });
        }

        const action = wasi_args[0]?.toLowerCase();
        const current = await wasi_getGroupSettings(sessionId, from) || {};

        if (!action) {
            const status = current.autoForward ? '🟢 فعال' : '🔴 غیر فعال';
            const targets = current.autoForwardTargets || [];

            let text = `🔄 *آٹو فارورڈ سیٹنگز*\n\n`;
            text += `📌 *حالت:* ${status}\n`;
            text += `🎯 *ٹارگٹس:* ${targets.length > 0 ? targets.join(', ') : 'کوئی نہیں'}\n\n`;
            text += `*کمانڈز:*\n`;
            text += `• \`.autoforward on\` - فعال کریں\n`;
            text += `• \`.autoforward off\` - غیر فعال کریں\n`;
            text += `• \`.autoforward set jid1, jid2\` - ٹارگٹس سیٹ کریں\n`;
            text += `• \`.autoforward add jid\` - نیا ٹارگٹ شامل کریں\n`;
            text += `• \`.autoforward clear\` - سب ٹارگٹس صاف کریں\n\n`;
            text += `> _اس گروپ کا ہر میسج ان ٹارگٹس پر بھیجا جائے گا۔_`;

            return await sock.sendMessage(from, { text });
        }

        if (action === 'on') {
            if (!current.autoForwardTargets || current.autoForwardTargets.length === 0) {
                return await sock.sendMessage(from, { text: '⚠️ پہلے ٹارگٹ JID سیٹ کریں: `.autoforward set <jids>`' });
            }
            await wasi_updateGroupSettings(sessionId, from, { autoForward: true });
            return await sock.sendMessage(from, { text: '✅ آٹو فارورڈ گروپ کے لیے فعال کر دیا گیا۔' });
        }

        if (action === 'off') {
            await wasi_updateGroupSettings(sessionId, from, { autoForward: false });
            return await sock.sendMessage(from, { text: '✅ آٹو فارورڈ غیر فعال کر دیا گیا۔' });
        }

        if (action === 'set') {
            const input = wasi_args.slice(1).join(' ');
            if (!input) return await sock.sendMessage(from, { text: '❌ درست استعمال: `.autoforward set jid1, jid2`' });

            const targets = input.split(',').map(j => {
                let jid = j.trim();
                if (jid && !jid.includes('@')) jid += '@s.whatsapp.net';
                return jid;
            }).filter(j => j.length > 5);

            await wasi_updateGroupSettings(sessionId, from, { autoForwardTargets: targets });
            return await sock.sendMessage(from, { text: `✅ ${targets.length} JID ٹارگٹس سیٹ کر دیے گئے۔` });
        }

        if (action === 'add') {
            let jid = wasi_args[1]?.trim();
            if (!jid) return await sock.sendMessage(from, { text: '❌ درست استعمال: `.autoforward add <jid>`' });
            if (!jid.includes('@')) jid += '@s.whatsapp.net';

            const targets = current.autoForwardTargets || [];
            if (!targets.includes(jid)) {
                targets.push(jid);
                await wasi_updateGroupSettings(sessionId, from, { autoForwardTargets: targets });
                return await sock.sendMessage(from, { text: `✅ نیا ٹارگٹ شامل کر دیا گیا: ${jid}` });
            } else {
                return await sock.sendMessage(from, { text: '⚠️ یہ JID پہلے ہی ٹارگٹس میں موجود ہے۔' });
            }
        }

        if (action === 'clear') {
            await wasi_updateGroupSettings(sessionId, from, { autoForwardTargets: [], autoForward: false });
            return await sock.sendMessage(from, { text: '✅ تمام آٹو فارورڈ ٹارگٹس صاف کر دیے گئے اور فیچر غیر فعال کر دیا گیا۔' });
        }

        return await sock.sendMessage(from, { text: '❌ نامعلوم عمل۔ مدد کے لیے `.autoforward` استعمال کریں۔' });
    }
};
