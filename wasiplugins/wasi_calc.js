module.exports = {
    name: 'wasicalc',
    description: 'A fun and advanced calculator',
    aliases: ['calc', 'calculate'],
    category: 'Fun',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args } = context;
        if (!wasi_args.length) {
            return await sock.sendMessage(from, { text: '❌ Usage: .calc 2 + 2' });
        }

        const expression = wasi_args.join(' ');
        try {
            // Safe evaluation using a restricted function approach
            // Replace 'x' with '*' for multiplication if user typed '2x5'
            const sanitized = expression.replace(/x/g, '*').replace(/[^-()\d/*+.]/g, '');

            // eslint-disable-next-line no-new-func
            const result = new Function('return ' + sanitized)();

            await sock.sendMessage(from, {
                text: `🧮 *WASI CALCULATOR*\n\n📝 *Expr:* ${expression}\n📊 *Result:* ${result}`
            });
        } catch (e) {
            await sock.sendMessage(from, { text: '❌ Invalid Expression.' });
        }
    }
};
