module.exports = {
    name: 'wasiai',
    description: 'Chat with Wasi AI (Powered by GPT-4o Model)',
    aliases: ['ai', 'gpt', 'bot'],
    category: 'AI',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_text } = context;
        const prefix = context.config?.prefix || '.';

        if (!wasi_args.length) {
            return await sock.sendMessage(from, { text: `❓ Ask me anything!\n\nUsage: *${prefix}ai Write a poem about code.*` });
        }

        const prompt = wasi_args.join(' ');

        await sock.sendMessage(from, { text: '🧠 *Thinking...*' });

        try {
            // Using a reliable free endpoint for GPT-4o style responses
            // Provider: Pollinations AI (Text) or Hercai usually works well for free bots
            const { wasi_get } = require('../wasilib/fetch');

            // Pollinations Text API
            const apiUrl = `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`;

            // Fetch response (It returns raw text usually)
            const response = await wasi_get(apiUrl);

            if (response) {
                // If response is buffer or object, handle accordingly. Pollinations text usually returns plain string body if fetch logic supports it.
                // wasi_get in generic implementations usually parses JSON. Pollinations returns raw text.
                // Let's assume wasi_get might try to parse JSON. 
                // Ideally we need raw text.

                // Let's create a specialized fetch if needed, but standard fetch often handles text.
                // If returned as object with no keys, it might be the string.

                const replyText = typeof response === 'string' ? response : JSON.stringify(response);

                await sock.sendMessage(from, {
                    text: `🤖 *WASI AI*\n\n${replyText}\n\n> Powering your imagination.`
                });
            } else {
                throw new Error('Empty response');
            }

        } catch (e) {
            console.error(e);
            await sock.sendMessage(from, { text: '❌ AI Brain offline. Try again later.' });
        }
    }
};
