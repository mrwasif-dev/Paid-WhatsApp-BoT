const axios = require('axios');

module.exports = {
    name: 'weather',
    aliases: ['w', 'clima'],
    category: 'Utilities',
    desc: 'Get weather information for any city',
    wasi_handler: async (wasi_sock, wasi_sender, context) => {
        const { wasi_args } = context;

        const query = wasi_args.join(' ');
        if (!query) {
            return wasi_sock.sendMessage(wasi_sender, {
                text: '❌ *Please provide a city name!*\n\nUsage: `.weather London`'
            });
        }

        try {
            // Use wttr.in API (free, no API key needed)
            const url = `https://wttr.in/${encodeURIComponent(query)}?format=j1`;
            const response = await axios.get(url, { timeout: 10000 });
            const data = response.data;

            if (!data.current_condition) {
                throw new Error('City not found');
            }

            const current = data.current_condition[0];
            const location = data.nearest_area[0];

            const weatherEmoji = {
                'Sunny': '☀️',
                'Clear': '🌙',
                'Partly cloudy': '⛅',
                'Cloudy': '☁️',
                'Overcast': '☁️',
                'Mist': '🌫️',
                'Fog': '🌫️',
                'Light rain': '🌧️',
                'Rain': '🌧️',
                'Heavy rain': '⛈️',
                'Thunderstorm': '⛈️',
                'Snow': '❄️',
                'Light snow': '🌨️'
            };

            const desc = current.weatherDesc[0].value;
            const emoji = weatherEmoji[desc] || '🌤️';

            const weatherText = `
${emoji} *Weather in ${location.areaName[0].value}, ${location.country[0].value}*

🌡️ *Temperature:* ${current.temp_C}°C (${current.temp_F}°F)
🌡️ *Feels Like:* ${current.FeelsLikeC}°C
💨 *Wind:* ${current.windspeedKmph} km/h ${current.winddir16Point}
💧 *Humidity:* ${current.humidity}%
👁️ *Visibility:* ${current.visibility} km
☁️ *Cloud Cover:* ${current.cloudcover}%
🌤️ *Condition:* ${desc}
🕐 *Updated:* ${current.observation_time}
`.trim();

            await wasi_sock.sendMessage(wasi_sender, { text: weatherText });

        } catch (error) {
            console.error('Weather error:', error);
            await wasi_sock.sendMessage(wasi_sender, {
                text: '❌ Failed to get weather. Check the city name and try again.'
            });
        }
    }
};
