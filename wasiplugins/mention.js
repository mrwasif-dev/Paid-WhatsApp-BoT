const { wasi_setMention, wasi_toggleMention } = require('../wasilib/database');

module.exports = {
    name: 'mention',
    aliases: ['setmention', 'mentionreply'],
    category: 'Owner',
    desc: 'Set a custom reply when the Owner is mentioned',
    wasi_handler: async (wasi_sock, wasi_chatId, context) => {
        const { wasi_msg, wasi_args, wasi_isOwner, wasi_isSudo, wasi_sender } = context;
        const config = require('../wasi');

        if (!wasi_isOwner && !wasi_isSudo) {
            // Double check config directly just in case context is stale
            const configOwner = config.ownerNumber;
            const envOwner = process.env.OWNER_NUMBER;
            const senderNum = wasi_sender.split('@')[0];

            const isKwOwner = (senderNum === configOwner) || (senderNum === envOwner);
            const sudoList = config.sudo || [];

            if (!isKwOwner) {
                // Check Sudo list with flexibility
                const isKwSudo = sudoList.some(sudoJid => {
                    const cleanSudo = sudoJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
                    return cleanSudo === senderNum;
                });

                if (!isKwSudo) {
                    return await wasi_sock.sendMessage(wasi_chatId, { text: '❌ Only the Owner or Sudo users can use this command.' }, { quoted: wasi_msg });
                }
            }
        }

        // Case 1: Toggle On/Off
        if (wasi_args[0] === 'on' || wasi_args[0] === 'off') {
            const status = wasi_args[0] === 'on';
            await wasi_toggleMention(config.sessionId, status);
            return await wasi_sock.sendMessage(wasi_msg.key.remoteJid, { text: `✅ Mention Reply feature is now *${wasi_args[0].toUpperCase()}*` }, { quoted: wasi_msg });
        }

        // Case 2: Set Reply (Text or Media)
        const quoted = wasi_msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        // Define media type detection
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const { wasi_uploadToCatbox } = require('../wasilib/uploader');

        let type = 'text';
        let content = '';
        let mimetype = '';
        let mediaBuffer = null;

        if (quoted) {
            // Check for various media types
            if (quoted.audioMessage) {
                type = 'audio';
                mimetype = quoted.audioMessage.mimetype;
                try {
                    mediaBuffer = await downloadMediaMessage({
                        message: quoted,
                        mediaKey: quoted.audioMessage.mediaKey,
                        directPath: quoted.audioMessage.directPath,
                        url: quoted.audioMessage.url
                    }, 'buffer', {});
                } catch (e) { console.error('Download Fail:', e); }

            } else if (quoted.videoMessage) {
                type = 'video';
                mimetype = quoted.videoMessage.mimetype;
                try {
                    mediaBuffer = await downloadMediaMessage({
                        message: quoted,
                        mediaKey: quoted.videoMessage.mediaKey,
                        directPath: quoted.videoMessage.directPath,
                        url: quoted.videoMessage.url
                    }, 'buffer', {});
                } catch (e) { console.error('Download Fail:', e); }

            } else if (quoted.imageMessage) {
                type = 'image';
                mimetype = quoted.imageMessage.mimetype;
                try {
                    mediaBuffer = await downloadMediaMessage({
                        message: quoted,
                        mediaKey: quoted.imageMessage.mediaKey,
                        directPath: quoted.imageMessage.directPath,
                        url: quoted.imageMessage.url
                    }, 'buffer', {});
                } catch (e) { console.error('Download Fail:', e); }

            } else if (quoted.conversation || quoted.extendedTextMessage?.text) {
                content = quoted.conversation || quoted.extendedTextMessage.text;
                type = 'text';
            }
        }

        // If media was downloaded, upload it
        if (mediaBuffer) {
            await wasi_sock.sendMessage(wasi_msg.key.remoteJid, { text: '⏳ Uploading media to server...' }, { quoted: wasi_msg });
            content = await wasi_uploadToCatbox(mediaBuffer);
            if (!content) {
                return await wasi_sock.sendMessage(wasi_msg.key.remoteJid, { text: '❌ Failed to upload media for mention reply.' }, { quoted: wasi_msg });
            }
        }

        // If not quoted media and no quoted text, check args
        if (!content && !mediaBuffer) {
            content = wasi_args.join(' ');
            type = 'text';
        }

        if (!content) {
            return await wasi_sock.sendMessage(wasi_msg.key.remoteJid, {
                text: '❌ Usage:\n\n' +
                    '1. *.mention on/off* (Enable/Disable)\n' +
                    '2. *.mention <text>* (Set text reply)\n' +
                    '3. Reply to a text/image/video/audio with *.mention*'
            }, { quoted: wasi_msg });
        }

        await wasi_setMention(config.sessionId, { type, content, mimetype });

        if (type === 'text') {
            await wasi_sock.sendMessage(wasi_msg.key.remoteJid, { text: `✅ Mention Reply updated to text:\n\n"${content}"` }, { quoted: wasi_msg });
        } else {
            await wasi_sock.sendMessage(wasi_msg.key.remoteJid, { text: `✅ Mention Reply updated to ${type}!\nURL: ${content}` }, { quoted: wasi_msg });
        }
    }
};
