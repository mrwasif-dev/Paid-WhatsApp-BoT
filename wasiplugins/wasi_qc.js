module.exports = {
    name: 'wasiqc',
    description: 'Generate a fake quoted sticker (Quote Message)',
    aliases: ['qc', 'quote', 'quotely'],
    category: 'Fun',
    wasi_handler: async (sock, from, context) => {
        const { wasi_msg, wasi_args, wasi_text, wasi_sender } = context;
        const { wasi_post } = require('../wasilib/fetch');
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');

        let text = wasi_args.join(' ');
        let targetJid = wasi_sender;
        let targetName = wasi_msg.pushName || 'User';

        // Handle Reply
        const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted) {
            // Use text from quoted message if available
            text = quoted.conversation || quoted.extendedTextMessage?.text || text;

            // Get participant
            const p = wasi_msg.message.extendedTextMessage.contextInfo.participant;
            targetJid = p || wasi_sender;
            // Trying to guess name is hard without store, fallback to 'User' or generic
        }

        if (!text) return await sock.sendMessage(from, { text: '❌ Provide text or reply to a message.' });
        if (text.length > 50) return await sock.sendMessage(from, { text: '❌ Text too long (Max 50 chars).' });

        await sock.sendMessage(from, { text: '🎨 *Painting Sticker...*' });

        try {
            // Get Profile Pic
            let ppUrl;
            try {
                ppUrl = await sock.profilePictureUrl(targetJid, 'image');
            } catch {
                ppUrl = 'https://i.pinimg.com/564x/8a/92/83/8a9283733055375498875323cb639446.jpg'; // default
            }

            // Payload for Quotly API
            const obj = {
                type: 'quote',
                format: 'png',
                backgroundColor: '#1b1425',
                width: 512,
                height: 768,
                scale: 2,
                messages: [{
                    entities: [],
                    avatar: true,
                    from: {
                        id: 1,
                        name: targetName,
                        photo: { url: ppUrl }
                    },
                    text: text,
                    replyMessage: {}
                }]
            };

            const response = await wasi_post('https://bot.lyo.su/quote/generate', obj);

            if (response && response.result && response.result.image) {
                const buffer = Buffer.from(response.result.image, 'base64');

                // Convert PNG buffer to WebP Sticker using ffmpeg
                const tempDir = path.join(__dirname, '../temp');
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

                const inputPath = path.join(tempDir, `qc_in_${Date.now()}.png`);
                const outputPath = path.join(tempDir, `qc_out_${Date.now()}.webp`);

                fs.writeFileSync(inputPath, buffer);

                await new Promise((resolve, reject) => {
                    exec(`ffmpeg -i "${inputPath}" -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,setsar=1" "${outputPath}"`, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                const stickerBuff = fs.readFileSync(outputPath);
                await sock.sendMessage(from, { sticker: stickerBuff }, { quoted: wasi_msg });

                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            } else {
                throw new Error('API Response invalid');
            }

        } catch (e) {
            console.error(e);
            await sock.sendMessage(from, { text: '❌ Failed to create quote.' });
        }
    }
};
