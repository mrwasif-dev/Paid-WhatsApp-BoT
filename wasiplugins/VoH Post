// plugins/autoForward.js
// =====================================================================
// 🔥 HERO AUTO-FORWARD PLUGIN
// 🔥 Multi-source → Multi-target
// 🔥 Only Media (Photo/Video/Document) + Emojis
// 🔥 Forwarded / Newsletter trace removed
// =====================================================================

module.exports = {
    name: 'autoForward', // optional plugin name
    description: 'Forward only media and emojis from source groups to targets',
    run: async (sock, wasi_msg) => {

        const wasi_origin = wasi_msg.key.remoteJid;

        // ===================== HERO CONFIG =====================
        // ENV / VAR based
        // Example:
        // SOURCE_JIDS=1201111111@g.us,1202222222@g.us
        // TARGET_JIDS=1209999999@g.us,923xxxx@s.whatsapp.net
        const HERO_AUTO_FORWARD = {
            sources: process.env.SOURCE_JIDS
                ? process.env.SOURCE_JIDS.split(',').map(j => j.trim()).filter(Boolean)
                : [],
            targets: process.env.TARGET_JIDS
                ? process.env.TARGET_JIDS.split(',').map(j => j.trim()).filter(Boolean)
                : []
        };
        // ========================================================

        if (!wasi_origin.endsWith('@g.us') || wasi_msg.key.fromMe) return;
        if (!HERO_AUTO_FORWARD.sources.includes(wasi_origin)) return;
        if (!wasi_msg.message) return;

        let relayMsg = null;
        let mType = null;

        // ===================== Detect Media =====================
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
            } else return; // not media or emoji → ignore
        } else return; // not media or emoji → ignore

        // ===================== Remove Forwarded / Newsletter Trace =====================
        if (mType && relayMsg[mType]?.contextInfo) {
            delete relayMsg[mType].contextInfo.isForwarded;
            delete relayMsg[mType].contextInfo.forwardingScore;
            delete relayMsg[mType].contextInfo.forwardedNewsletterMessageInfo;
            if (Object.keys(relayMsg[mType].contextInfo).length === 0) {
                delete relayMsg[mType].contextInfo;
            }
        }

        // ===================== Forward to all targets =====================
        for (const targetJid of HERO_AUTO_FORWARD.targets) {
            try {
                await sock.relayMessage(targetJid, relayMsg, { messageId: sock.generateMessageTag() });
            } catch (err) {
                console.error(`[AUTO-FORWARD] Failed → ${targetJid}`, err.message);
            }
        }

    }
};
