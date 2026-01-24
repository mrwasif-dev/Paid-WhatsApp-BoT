const { wasi_addAutoReply, wasi_deleteAutoReply, wasi_getAutoReplies } = require('../wasilib/database');

module.exports = {
    name: 'autoreply',
    description: 'Set custom auto-replies for specific triggers',
    aliases: ['ar'],
    category: 'Tools',
    wasi_handler: async (sock, from, context) => {
        const { wasi_args, wasi_isAdmin, wasi_isOwner, wasi_isSudo, wasi_isGroup, sessionId } = context;

        // Admin/Owner only for setting these up
        if (!wasi_isOwner && !wasi_isSudo && (wasi_isGroup && !wasi_isAdmin)) {
            return await sock.sendMessage(from, { text: '❌ You need Admin privileges to manage auto-replies.' });
        }

        const action = wasi_args[0]?.toLowerCase();

        // List mode
        if (!action || action === 'list') {
            const replies = await wasi_getAutoReplies(sessionId);
            if (!replies || replies.length === 0) {
                let text = `🤖 *AUTO-REPLY MANAGER*\n\n`;
                text += `❌ No active auto-replies.\n\n`;
                text += `*Usage:*\n`;
                text += `• \`.ar set "hi", "Hello there!"\`\n`;
                text += `• \`.ar del "hi"\``;
                return await sock.sendMessage(from, { text });
            }

            let text = `🤖 *AUTO-REPLY LIST (${replies.length})*\n\n`;
            text += replies.map((r, i) => `${i + 1}. *"${r.trigger}"* ➡️ "${r.reply}"`).join('\n\n');
            text += `\n\n> Use \`.ar del "trigger"\` to remove.`;
            return await sock.sendMessage(from, { text });
        }

        // Add/Set mode
        if (action === 'set' || action === 'add') {
            const fullArg = wasi_args.slice(1).join(' ');
            // Regex to capture "trigger" , "reply" allowing for spaces and comma separation
            // Matches: "word" , "response"
            const match = fullArg.match(/"([^"]+)"\s*,\s*"([^"]+)"/);

            if (!match) {
                return await sock.sendMessage(from, { text: '❌ Invalid Format.\n\nUsage:\n`.ar set "trigger word", "your reply message"`\n\n(Don\'t forget the quotes!)' });
            }

            const trigger = match[1].toLowerCase(); // Store trigger as lowercase for consistent matching
            const reply = match[2];

            const success = await wasi_addAutoReply(sessionId, trigger, reply);
            if (success) {
                return await sock.sendMessage(from, { text: `✅ *Auto-Reply Set!*\n\n🗣️ Trigger: "${trigger}"\n💬 Reply: "${reply}"` });
            } else {
                return await sock.sendMessage(from, { text: '❌ Failed to save auto-reply. Database error.' });
            }
        }

        // Delete mode
        if (action === 'del' || action === 'delete' || action === 'remove') {
            const fullArg = wasi_args.slice(1).join(' ');
            // Regex to capture "trigger" or just the word if no quotes
            const match = fullArg.match(/"([^"]+)"/) || [null, fullArg.trim()];
            const trigger = match[1] ? match[1].toLowerCase() : fullArg.trim().toLowerCase();

            if (!trigger) {
                return await sock.sendMessage(from, { text: '❌ Please specify the trigger to delete.\nUsage: `.ar del "trigger"`' });
            }

            const success = await wasi_deleteAutoReply(sessionId, trigger);
            if (success) {
                return await sock.sendMessage(from, { text: `✅ Deleted auto-reply for: "${trigger}"` });
            } else {
                return await sock.sendMessage(from, { text: '❌ Failed to delete. Maybe it didn\'t exist?' });
            }
        }

        return await sock.sendMessage(from, { text: '❌ Unknown action. Usage: `.ar set "trigger", "reply"`' });
    }
};
