const axios = require('axios');

module.exports = {
    name: 'userinfo',
    aliases: ['siminfo', 'cnic', 'simcheck'],
    category: 'Utilities',
    desc: 'Get user information by phone number',
    ownerOnly: true, // Sensitive data - owner only
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args } = context;

        if (!wasi_args) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Please provide a phone number!*\n\nUsage: `.userinfo 03xxxxxxxxx`'
            });
        }

        // Clean the number - remove spaces, dashes, and non-digits
        const rawInput = Array.isArray(wasi_args) ? wasi_args.join('') : wasi_args;
        const number = rawInput.replace(/[^0-9]/g, '');

        if (!number || number.length < 10) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Invalid phone number!*\n\nPlease provide a valid number like: `03xxxxxxxxx`'
            });
        }

        try {
            await wasi_sock.sendMessage(wasi_sender, { text: '🔍 Fetching information...' });

            const url = `https://sim.f-a-k.workers.dev/?q=${number}`;
            const response = await axios.get(url, { timeout: 15000 });
            const data = response.data;

            // Check if we got valid data
            if (!data || data.error || !data.name || data.name === 'N/A' || data.name === '') {
                return wasi_sock.sendMessage(wasi_sender, {
                    text: `❌ *Sorry, I can't get info of this user!*\n\n📱 Number: ${number}\n\n_No data found in database_`
                });
            }

            // Build response message
            let infoText = `
╭─────────────────────╮
│   📱 *USER INFO*
╰─────────────────────╯

📞 *Phone:* ${number}
👤 *Name:* ${data.name || 'N/A'}
🆔 *CNIC:* ${data.cnic || 'N/A'}
📍 *Address:* ${data.address || 'N/A'}
🏠 *City:* ${data.city || 'N/A'}
🏢 *Provider:* ${data.provider || 'N/A'}

_Data fetched successfully!_
`.trim();

            await wasi_sock.sendMessage(wasi_sender, { text: infoText });

        } catch (error) {
            console.error('UserInfo error:', error.message);

            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                return wasi_sock.sendMessage(wasi_sender, {
                    text: '❌ *Request timed out!*\n\nPlease try again later.'
                });
            }

            await wasi_sock.sendMessage(wasi_sender, {
                text: `❌ *Sorry, I can't get info of this user!*\n\n📱 Number: ${number}\n\n_Server error or no data available_`
            });
        }
    }
};
