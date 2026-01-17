const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

module.exports = {
    name: 'vv',
    aliases: ['viewonce', 'retrive'],
    category: 'Media',
    desc: 'Retrieve and send view once messages',
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_msg }) => {
        try {
            // Check if message quotes a view once message
            const quotedMsg = wasi_msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMsg) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please reply to a View Once message.' });
            }

            // Detect view once type
            const viewOnceMsg = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2;
            let actualMsg = viewOnceMsg?.message?.imageMessage || viewOnceMsg?.message?.videoMessage || viewOnceMsg?.message?.audioMessage;

            // Sometimes view once messages are just regular media with a flag, or different structure
            if (!actualMsg) {
                if (quotedMsg.imageMessage?.viewOnce) actualMsg = quotedMsg.imageMessage;
                else if (quotedMsg.videoMessage?.viewOnce) actualMsg = quotedMsg.videoMessage;
                else if (quotedMsg.audioMessage?.viewOnce) actualMsg = quotedMsg.audioMessage;

                // Fallback: check if the quoted message itself IS an image/video but we missed the viewOnce flag
                // or if it's a raw media message that we want to retrieve anyway (acting as a general retrieval tool)
                if (!actualMsg && (quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage)) {
                    actualMsg = quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage;
                }
            }

            if (!actualMsg) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Could not detect media content in the quoted message.' });
            }

            // Get media type
            let type = '';
            let content = actualMsg;

            if (content.mimetype?.includes('image') || quotedMsg.imageMessage || viewOnceMsg?.message?.imageMessage) {
                type = 'image';
                if (!content) content = quotedMsg.imageMessage || viewOnceMsg.message.imageMessage;
            } else if (content.mimetype?.includes('video') || quotedMsg.videoMessage || viewOnceMsg?.message?.videoMessage) {
                type = 'video';
                if (!content) content = quotedMsg.videoMessage || viewOnceMsg.message.videoMessage;
            } else if (content.mimetype?.includes('audio') || quotedMsg.audioMessage || viewOnceMsg?.message?.audioMessage) {
                type = 'audio';
                if (!content) content = quotedMsg.audioMessage || viewOnceMsg.message.audioMessage;
            }

            if (!content || !type) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Unknown media type.' });

            await wasi_sock.sendMessage(wasi_sender, { text: '⏳ Retrieving media...' });

            // Download
            const stream = await downloadContentFromMessage(content, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            // Resend
            if (type === 'image') {
                await wasi_sock.sendMessage(wasi_sender, { image: buffer, caption: '✅ Here is the View Once image' }, { quoted: wasi_msg });
            } else if (type === 'video') {
                await wasi_sock.sendMessage(wasi_sender, { video: buffer, caption: '✅ Here is the View Once video' }, { quoted: wasi_msg });
            } else if (type === 'audio') {
                await wasi_sock.sendMessage(wasi_sender, { audio: buffer, mimetype: 'audio/mp4', ptt: false }, { quoted: wasi_msg });
            }

        } catch (e) {
            console.error('VV Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
