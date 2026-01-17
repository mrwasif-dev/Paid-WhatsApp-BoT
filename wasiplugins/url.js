const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const axios = require('axios');
const FormData = require('form-data');

module.exports = {
    name: 'url',
    aliases: ['tourl', 'imgurl', 'upload'],
    category: 'Media',
    desc: 'Upload image and get URL',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg } = context;

        // Check for quoted message or direct media
        const quotedMsg = wasi_msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const mediaMsg = wasi_msg.message.imageMessage || quotedMsg?.imageMessage;

        if (!mediaMsg) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Reply to an image to upload it!*\n\nUsage: Reply to an image with `.url`'
            });
        }

        try {
            await wasi_sock.sendMessage(wasi_sender, { text: '⏳ Uploading image...' });

            // Get the actual message to download from
            const msgToDownload = quotedMsg ?
                { message: quotedMsg, key: wasi_msg.message.extendedTextMessage.contextInfo } :
                wasi_msg;

            // Download media
            const buffer = await downloadMediaMessage(
                msgToDownload,
                'buffer',
                {},
                {
                    reuploadRequest: wasi_sock.updateMediaMessage
                }
            );

            // Try Telegraph first (most reliable)
            let imageUrl;
            try {
                const form = new FormData();
                form.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

                const response = await axios.post('https://telegra.ph/upload', form, {
                    headers: form.getHeaders(),
                    timeout: 30000
                });

                if (response.data && response.data[0]?.src) {
                    imageUrl = 'https://telegra.ph' + response.data[0].src;
                }
            } catch (e) {
                // Fallback to catbox.moe
                try {
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

                    const response = await axios.post('https://catbox.moe/user/api.php', form, {
                        headers: form.getHeaders(),
                        timeout: 30000
                    });

                    if (response.data) {
                        imageUrl = response.data;
                    }
                } catch (e2) {
                    throw new Error('All upload services failed');
                }
            }

            if (!imageUrl) {
                throw new Error('Failed to get URL');
            }

            await wasi_sock.sendMessage(wasi_sender, {
                text: `✅ *Image Uploaded Successfully!*\n\n🔗 *URL:*\n${imageUrl}\n\n_Link will expire in a few days_`
            });

        } catch (error) {
            console.error('URL error:', error);
            await wasi_sock.sendMessage(wasi_sender, {
                text: '❌ Failed to upload image. Please try again.'
            });
        }
    }
};
