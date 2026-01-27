

/*
const fs = require('fs');
const path = require('path');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('../wasilib/ffmpeg'); // Use our configured ffmpeg

module.exports = {
    name: 'convert',
    description: 'Convert media: video/audio to mp3, sticker to image, etc.',
    aliases: ['tomp3', 'toimg', 'tosticker', 'mp3', 'img', 's'],
    category: 'Tools',
    wasi_handler: async (sock, from, context) => {
        const { wasi_msg, wasi_text } = context;
        const prefix = context.config?.prefix || '.';
        const cmd = wasi_text.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();

        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

        // 1. Determine what we are converting FROM
        const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const targetMsg = quoted || wasi_msg.message;

        let targetType = '';
        if (targetMsg.videoMessage) targetType = 'video';
        else if (targetMsg.audioMessage) targetType = 'audio';
        else if (targetMsg.imageMessage) targetType = 'image';
        else if (targetMsg.stickerMessage) targetType = 'sticker';

        if (!targetType) {
            return await sock.sendMessage(from, { text: '❌ Please reply to a video, audio, image, or sticker.' });
        }

        await sock.sendMessage(from, { text: '⏳ *Converting...*' });

        // 2. Download Media
        let stream;
        try {
            const mediaKey = targetType === 'sticker' ? targetMsg.stickerMessage : targetMsg[targetType + 'Message'] || targetMsg;
            stream = await downloadContentFromMessage(mediaKey, targetType);
        } catch (e) {
            return await sock.sendMessage(from, { text: '❌ Failed to download media.' });
        }

        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const inputPath = path.join(tempDir, `input_${Date.now()}`);
        const outputPath = path.join(tempDir, `output_${Date.now()}`);

        fs.writeFileSync(inputPath, buffer);

        // 3. Execution Helpers
        try {
            // --- VIDEO/AUDIO TO MP3 ---
            if (cmd === 'tomp3' || cmd === 'mp3') {
                if (targetType !== 'video' && targetType !== 'audio') {
                    throw new Error('Only Video or Audio can be converted to MP3.');
                }

                await new Promise((resolve, reject) => {
                    ffmpeg(inputPath)
                        .toFormat('mp3')
                        .audioBitrate('192k')
                        .on('error', reject)
                        .on('end', resolve)
                        .save(outputPath + '.mp3');
                });

                const buff = fs.readFileSync(outputPath + '.mp3');
                await sock.sendMessage(from, {
                    audio: buff,
                    mimetype: 'audio/mpeg',
                    ptt: false,
                    fileName: 'wasi_converted.mp3'
                }, { quoted: wasi_msg });
            }

            // --- STICKER TO IMAGE ---
            else if (cmd === 'toimg' || cmd === 'img') {
                if (targetType !== 'sticker') {
                    throw new Error('Only Stickers can be converted to Image.');
                }

                await new Promise((resolve, reject) => {
                    ffmpeg(inputPath)
                        .toFormat('png')
                        .on('error', reject)
                        .on('end', resolve)
                        .save(outputPath + '.png');
                });

                const buff = fs.readFileSync(outputPath + '.png');
                await sock.sendMessage(from, {
                    image: buff,
                    caption: '🖼️ *Converted to Image*\n> WASI-MD-V7'
                }, { quoted: wasi_msg });
            }

            // --- IMAGE/VIDEO TO STICKER ---
            else if (cmd === 'tosticker' || cmd === 's') {
                if (targetType === 'image' || targetType === 'video') {

                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .outputOptions([
                                "-vcodec libwebp",
                                "-vf scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1",
                                "-loop 0",
                                "-ss 00:00:00.0",
                                "-t 00:00:10.0",
                                "-preset default",
                                "-an",
                                "-vsync 0",
                                "-s 512:512"
                            ])
                            .toFormat('webp')
                            .on('error', reject)
                            .on('end', resolve)
                            .save(outputPath + '.webp');
                    });

                    const buff = fs.readFileSync(outputPath + '.webp');
                    await sock.sendMessage(from, { sticker: buff }, { quoted: wasi_msg });
                } else {
                    throw new Error('Reply to an Image or Video to make a sticker.');
                }
            }

            else {
                // Determine based on content if just 'convert'
                if ((targetType === 'video' || targetType === 'audio')) {
                    // Default to mp3
                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .toFormat('mp3')
                            .audioBitrate('192k')
                            .on('error', reject)
                            .on('end', resolve)
                            .save(outputPath + '.mp3');
                    });
                    const buff = fs.readFileSync(outputPath + '.mp3');
                    await sock.sendMessage(from, { audio: buff, mimetype: 'audio/mpeg', ptt: false }, { quoted: wasi_msg });
                }
            }

        } catch (err) {
            console.error(err);
            await sock.sendMessage(from, { text: `❌ Conversion Failed: ${err.message}` });
        } finally {
            // Cleanup
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath + '.mp3')) fs.unlinkSync(outputPath + '.mp3');
            if (fs.existsSync(outputPath + '.png')) fs.unlinkSync(outputPath + '.png');
            if (fs.existsSync(outputPath + '.webp')) fs.unlinkSync(outputPath + '.webp');
        }
    }
};





*/
