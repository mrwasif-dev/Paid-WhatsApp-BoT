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
        console.log('🎵 BGM Plugin Triggered');
        const { wasi_msg, wasi_args, sessionId } = context;

        // Ensure arguments exist
        if (wasi_args.length < 1) {
            return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Usage:\n.bgm on\n.bgm off\n.bgm add <word>\n.bgm delete <word>' });
        }

        const action = wasi_args[0].toLowerCase();

        // 1. .bgm on / off
        // 1. .bgm on / off
        if (action === 'on' || action === 'off') {
            const status = action === 'on';
            const currentStatus = await wasi_isBgmEnabled(sessionId);

            if (currentStatus === status) {
                return await wasi_sock.sendMessage(wasi_sender, { text: `⚠️ BGM is *ALREADY ${status ? 'ENABLED' : 'DISABLED'}*` });
            }

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

            // NEW: Use centralized media handler
            const { wasi_downloadMedia, wasi_uploadMedia } = require('../wasilib/media');

            const buffer = await wasi_downloadMedia(wasi_msg, wasi_sock);
            if (!buffer) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Failed to download media. Please try again.' });
            }

            try {
                // EXTRAC MIMETYPE
                const mime = quotedMsg.audioMessage?.mimetype || 'audio/mp4';
                let ext = '.mp3';
                let finalMime = 'audio/mpeg';

                if (mime.includes('opus') || mime.includes('ogg')) {
                    ext = '.opus';
                    finalMime = 'audio/ogg; codecs=opus';
                } else if (mime.includes('mp4')) {
                    ext = '.m4a';
                    finalMime = 'audio/mp4';
                }

                // Upload with correct extension
                const url = await wasi_uploadMedia(buffer, `bgm-${Date.now()}${ext}`);

                // Save to DB with proper mimetype
                await wasi_addBgm(sessionId, word, url.trim(), finalMime);

                return await wasi_sock.sendMessage(wasi_sender, { text: `✅ BGM Added!\n\nTrigger: *${word}*\nMime: ${finalMime}` });
            } catch (e) {
                console.error('BGM Add Error:', e);
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
