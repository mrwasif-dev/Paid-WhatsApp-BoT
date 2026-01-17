module.exports = {
    name: 'setbio',
    aliases: ['status', 'setstatus'],
    category: 'Profile',
    desc: 'Set your WhatsApp About/Bio',
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_args }) => {
        try {
            if (!wasi_args) {
                return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please provide text for your bio.\nUsage: .setbio Available' });
            }

            await wasi_sock.updateProfileStatus(wasi_args);
            await wasi_sock.sendMessage(wasi_sender, { text: '✅ Bio updated successfully!' });

        } catch (e) {
            console.error('SetBio Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
