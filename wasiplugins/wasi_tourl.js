module.exports = {
    name: 'wasitourl',
    description: 'Upload media to a URL using Catbox',
    aliases: ['tourl', 'upload', 'link'],
    category: 'Tools',
    wasi_handler: async (sock, from, context) => {
        const { wasi_msg } = context;
        if (!wasi_msg.message?.imageMessage && !wasi_msg.message?.videoMessage) {
            const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted || (!quoted.imageMessage && !quoted.videoMessage)) {
                return await sock.sendMessage(from, { text: '❌ Please reply to an image or video.' });
            }
        }

        await sock.sendMessage(from, { text: '☁️ *Uploading...*' });

        try {
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            const fs = require('fs');
            const path = require('path');
            const { wasi_upload } = require('../wasilib/uploader');

            // Handle Quoted or Direct
            const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const targetMsg = quoted || wasi_msg.message;
            const type = targetMsg.imageMessage ? 'image' : 'video';
            const mediaKey = targetMsg.imageMessage || targetMsg.videoMessage;

            const stream = await downloadContentFromMessage(mediaKey, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            // Save Temp
            const tempDir = path.join(__dirname, '../temp');
            const ext = type === 'image' ? 'jpg' : 'mp4';
            const tempPath = path.join(tempDir, `upload_${Date.now()}.${ext}`);
            fs.writeFileSync(tempPath, buffer);

            // Upload
            const url = await wasi_upload(tempPath);

            await sock.sendMessage(from, {
                text: `🔗 *LINK GENERATED*\n\n${url}\n\n> WASI-MD-V7`
            }, { quoted: wasi_msg });

            fs.unlinkSync(tempPath);

        } catch (e) {
            console.error(e);
            await sock.sendMessage(from, { text: '❌ Upload Failed.' });
        }
    }
};
