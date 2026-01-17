const util = require('util');

module.exports = {
    name: 'eval',
    aliases: ['e', '>'],
    category: 'Admin',
    desc: 'Evaluate JavaScript code',
    ownerOnly: true,
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_msg, wasi_args, wasi_text }) => {
        try {
            // "eval" is dangerous, so restrict to owner (handled by ownerOnly: true check in index.js)
            // We expose commonly used variables to the eval scope
            // wasi_sock, wasi_sender, wasi_msg, wasi_args are available in scope

            let code = wasi_args;
            if (!code) return await wasi_sock.sendMessage(wasi_sender, { text: '❌ Please provide code to evaluate.' });

            let evaled = await eval(code);

            if (typeof evaled !== 'string') {
                evaled = util.inspect(evaled);
            }

            await wasi_sock.sendMessage(wasi_sender, { text: evaled });
        } catch (e) {
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
