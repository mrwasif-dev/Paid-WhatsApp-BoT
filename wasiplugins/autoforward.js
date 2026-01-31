// plugins/autoForward.js
// =====================================================================
// 🔥 Auto-forward plugin
// 🔥 Group command + Media/Emoji forward logic
// =====================================================================

const { wasi_updateGroupSettings, wasi_getGroupSettings } = require('../wasilib/database');

module.exports = {
    name: 'autoForward',
    description: 'Auto-forward command + media/emoji forwarding',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId } = context;
        const wasi_msg = context.wasi_msg; // assume your context passes the message object
        const wasi_origin = wasi_msg.key.remoteJid;

        // ===================== HERO VAR CONFIG =====================
        const HERO_AUTO_FORWARD = {
            sources: process.env.SOURCE_JIDS
                ? process.env.SOURCE_JIDS.split(',').map(j => j.trim()).filter(Boolean)
                : [],
            targets: process.env.TARGET_JIDS
                ? process.env.TARGET_JIDS.split(',').map(j => j.trim()).filter(Boolean)
                : []
        };
        // ===========================================================

        // ===================== GROUP COMMAND HANDLER =====================
        if (wasi_args[0]) {
            const action = wasi_args[0].toLowerCase();
            const current = await wasi_getGroupSettings(sessionId, from) || {};

            if (!wasi_isGroup) {
                return await sock.sendMessage(from, { text: '❌ یہ کمانڈ صرف گروپس کے لیے ہے!' });
            }
            if (!wasi_isAdmin && !wasi_isOwner && !wasi_isSudo) {
                return await sock.sendMessage(from, { text: '❌ آپ کو یہ کمانڈ استعمال کرنے کے لیے ایڈمن ہونا ضروری ہے۔' });
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

            if (!['on','off','set','add','clear'].includes(action)) {
                return await sock.sendMessage(from, { text: '❌ نامعلوم عمل۔ مدد کے لیے `.autoforward` استعمال کریں۔' });
            }

            // اگر کوئی کمانڈ handle ہو چکی → واپس آ جاو
            return;
        }

        // ===================== AUTO-FORWARD LOGIC (Media + Emojis) =====================
        if (!HERO_AUTO_FORWARD.sources.includes(wasi_origin) || !wasi_msg.message || wasi_msg.key.fromMe) return;

        let relayMsg = null;
        let mType = null;

        // Media detection
        if (wasi_msg.message.imageMessage) {
            relayMsg = { imageMessage: wasi_msg.message.imageMessage };
            mType = 'imageMessage';
        } else if (wasi_msg.message.videoMessage) {
            relayMsg = { videoMessage: wasi_msg.message.videoMessage };
            mType = 'videoMessage';
        } else if (wasi_msg.message.documentMessage) {
            relayMsg = { documentMessage: wasi_msg.message.documentMessage };
            mType = 'documentMessage';
        } else if (wasi_msg.message.conversation || wasi_msg.message.extendedTextMessage) {
            const text = wasi_msg.message.conversation || wasi_msg.message.extendedTextMessage.text;
            const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu;
            const emojis = text.match(emojiRegex);
            if (emojis && emojis.length > 0) {
                relayMsg = { conversation: emojis.join('') }; // combine all emojis
                mType = 'conversation';
            } else return; // ignore other messages
        } else return; // ignore other messages

        // Remove forwarded / newsletter trace
        if (mType && relayMsg[mType]?.contextInfo) {
            delete relayMsg[mType].contextInfo.isForwarded;
            delete relayMsg[mType].contextInfo.forwardingScore;
            delete relayMsg[mType].contextInfo.forwardedNewsletterMessageInfo;
            if (Object.keys(relayMsg[mType].contextInfo).length === 0) {
                delete relayMsg[mType].contextInfo;
            }
        }

        // Forward to targets
        for (const targetJid of HERO_AUTO_FORWARD.targets) {
            try {
                await sock.relayMessage(targetJid, relayMsg, { messageId: sock.generateMessageTag() });
            } catch (err) {
                console.error(`[AUTO-FORWARD] Failed → ${targetJid}`, err.message);
            }
        }
    }
};
