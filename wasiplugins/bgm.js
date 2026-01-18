const {
    wasi_addBgm,
    wasi_deleteBgm,
    wasi_toggleBgm,
    wasi_isBgmEnabled,
    wasi_getAllBgms
} = require('../wasilib/database');

module.exports = {
    name: 'bgm',
    aliases: ['bgm'],
    category: 'Settings',
    desc: 'Manage Background Music (BGM)\n.bgm on/off\n.bgm add <word> (reply to audio)\n.bgm delete <word>',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_msg, wasi_args, sessionId } = context;

        // Ensure arguments exist
        if (wasi_args.length < 1) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage:\n.bgm on\n.bgm off\n.bgm add <word>\n.bgm delete <word>' });
        }

        const action = wasi_args[0].toLowerCase();

        // 1. .bgm on / off
        if (action === 'on' || action === 'off') {
            const status = action === 'on';
            await wasi_toggleBgm(sessionId, status);
            return await wasi_sock.sendMessage(wasi_sender, { text: `✅ BGM is now *${status ? 'ENABLED' : 'DISABLED'}*` });
        }

        // 2. .bgm add <word>
        if (action === 'add') {
            const word = wasi_args.slice(1).join(' ').toLowerCase();
            if (!word) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please specify a word.\nExample: .bgm add hello' });

            const quotedMsg = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMsg || (!quotedMsg.audioMessage && !quotedMsg.videoMessage)) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please reply to an audio or video file.' });
            }

            // We need a way to get a permanent URL for this audio.
            // Since we can't upload to a server easily in this code, we might need to rely on the media buffer.
            // BUT, the database stores "audioUrl". 
            // Option A: Store URL if the user provides a link (which they didn't, they replied).
            // Option B: Download media -> Upload to telegraph/catbox -> Save URL.
            // Let's implement Option B (Upload to Catbox/Telegraph) if we have a uploader.
            // Check if there is a 'media.js' or similar utility. 
            // Assuming we don't have a built-in uploader, we'll implement a simple one using 'catbox' logic or similar inside the plugin?
            // Actually, for simplicity and speed, let's use the 'downloadMediaMessage' from Baileys and a generic upload function.

            // Wait, I can't write a complex uploader from scratch instantly.
            // Let's assume there is a scraper/uploader available or write a minimal one.
            // Let's try to upload to `pomf2.lain.la` or `catbox.moe`.

            // For now, I will use a placeholder logic:
            // "Please provide a URL" or I will try to implement a simple upload.

            // User requirement: "in reply of auduio or video this will save in databse"
            // So we MUST handle the upload.

            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const fs = require('fs');
            const path = require('path');
            const axios = require('axios');
            const FormData = require('form-data');

            // Download
            let buffer;
            try {
                // Reconstruct buffer logic
                buffer = await downloadMediaMessage(
                    { key: wasi_msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg },
                    'buffer',
                    {},
                    {
                        logger: console,
                        reuploadRequest: wasi_sock.updateMediaMessage
                    }
                );
            } catch (e) {
                // Fallback if direct download fails (maybe use msg itself)
                // Or better, just try to download the quoted.
                // Actually, Baileys download requires the message object. 
                // Let's keep it simple: inform user if fail.
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to download media. Please try again.' });
            }

            // Upload to Catbox
            try {
                const formData = new FormData();
                formData.append('reqtype', 'fileupload');
                formData.append('fileToUpload', buffer, 'bgm.mp3');

                const response = await axios.post('https://catbox.moe/user/api.php', formData, {
                    headers: formData.getHeaders()
                });

                const url = response.data;
                if (!url || !url.startsWith('http')) {
                    throw new Error('Upload failed');
                }

                await wasi_addBgm(sessionId, word, url.trim());
                return await wasi_sock.sendMessage(wasi_sender, { text: `✅ BGM Added!\n\nTrigger: *${word}*\nURL: ${url}` });
            } catch (e) {
                console.error('Upload Error:', e);
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to upload media to cloud.' });
            }
        }

        // 3. .bgm delete <word>
        if (action === 'delete') {
            const word = wasi_args.slice(1).join(' ').toLowerCase();
            if (!word) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please specify the word to delete.' });

            const success = await wasi_deleteBgm(sessionId, word);
            if (success) {
                return await wasi_sock.sendMessage(wasi_sender, { text: `✅ BGM for *${word}* deleted.` });
            } else {
                return await wasi_sock.sendMessage(wasi_sender, { text: `❌ No BGM found for *${word}*.` });
            }
        }

        // 4. .bgm list (optional)
        if (action === 'list') {
            const bgms = await wasi_getAllBgms(sessionId);
            if (bgms.length === 0) return await wasi_sock.sendMessage(wasi_sender, { text: '📭 No BGM triggers set.' });

            let txt = '🎵 *BGM Triggers:*\n\n';
            bgms.forEach(b => txt += `• ${b.trigger}\n`);
            return await wasi_sock.sendMessage(wasi_sender, { text: txt });
        }
    }
};
