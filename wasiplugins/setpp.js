const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

module.exports = {
    name: 'setpp',
    aliases: ['setprofile', 'setdp'],
    category: 'Profile',
    desc: 'Set your full profile picture',
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_msg, wasi_args }) => {
        try {
            const botNumber = wasi_sock.user.id.split(':')[0] + '@s.whatsapp.net';
            // Check if user is owner or it's the bot itself (if bot is changing its own PP)
            // Ideally, we want to change the BOT's profile picture.

            // Check for quoted image or attached image
            const quotedMsg = wasi_msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const imageMsg = wasi_msg.message.imageMessage || quotedMsg?.imageMessage;

            if (!imageMsg) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please reply to an image or upload an image with the caption .setpp' });
            }

            await wasi_sock.sendMessage(wasi_sender, { text: '⏳ Updating profile picture...' });

            const stream = await downloadContentFromMessage(imageMsg, 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            // Update Profile Picture
            // Using updateProfilePicture to accept a buffer
            await wasi_sock.updateProfilePicture(botNumber, buffer);

            await wasi_sock.sendMessage(wasi_sender, { text: '✅ Profile picture updated successfully!' });

        } catch (e) {
            console.error('SetPP Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
