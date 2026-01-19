const { wasi_get, wasi_getBuffer } = require('./fetch');

/**
 * TikTok Downloader with Fallback Strategy
 * @param {string} url - The TikTok video URL
 * @returns {Promise<Object>} - { result: { title, author, cover, wm_url, no_wm_url, music, type: 'video'|'image' } }
 */
async function wasi_tiktok(url) {
    // Strategy 1: TiklyDown
    try {
        const apiUrl = `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`;
        const data = await wasi_get(apiUrl);

        if (data && data.id) {
            return {
                status: true,
                provider: 'TiklyDown',
                title: data.title,
                author: data.author?.name,
                cover: data.thumbnail,
                video: data.video?.noWatermark,
                audio: data.music?.play_url,
                caption: data.title
            };
        }
    } catch (e) {
        console.error('TiklyDown Failed:', e.message);
    }

    // Strategy 2: TikWM
    try {
        const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}`;
        const data = await wasi_get(apiUrl);

        if (data && data.data) {
            const t = data.data;
            return {
                status: true,
                provider: 'TikWM',
                title: t.title,
                author: t.author?.nickname,
                cover: t.cover,
                video: t.play,
                audio: t.music,
                caption: t.title
            };
        }
    } catch (e) {
        console.error('TikWM Failed:', e.message);
    }

    return { status: false, message: 'All providers failed' };
}

module.exports = {
    wasi_tiktok
};
