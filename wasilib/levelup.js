const canvacord = require('canvacord');

async function generateLevelUpCard(userJid, level, xp, ppUrl) {
    try {
        const username = userJid.split('@')[0];

        // Calculate needed XP for next level to show progress
        const neededXP = (level + 1) ** 2 * 100;

        const rank = new canvacord.Rank()
            .setAvatar(ppUrl)
            .setCurrentXP(xp || 0)
            .setRequiredXP(neededXP)
            .setLevel(level)
            .setStatus('online')
            .setProgressBar('#00FF00', 'COLOR')
            .setUsername(username)
            .setDiscriminator('0000')
            .setOverlay('#000000', 0.7) // Darker overlay for better text visibility
            .setBackground('IMAGE', 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b'); // Cyberpunk/Tech background

        // Adjust font size? Canvacord handles it.

        return await rank.build();
    } catch (e) {
        console.error('LevelUp Card Gen Error:', e);
        return null;
    }
}

module.exports = { generateLevelUpCard };
