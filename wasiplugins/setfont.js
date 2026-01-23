const config = require('../wasi');
const { fonts } = require('../wasilib/fonts');
const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'setfont',
    category: 'Settings',
    desc: 'Change the global font style of the bot',
    ownerOnly: true,
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_args }) => {
        try {
            // Only owner? 
            if (!wasi_args || wasi_args.length === 0) {
                const styles = Object.keys(fonts).map(f => `> ${f}`).join('\n');
                return await wasi_sock.sendMessage(wasi_sender, {
                    text: `🔤 *Available Font Styles:*\n\n${styles}\n\nUsage: .setfont <style>`
                });
            }

            const style = wasi_args[0].toLowerCase();
            if (!fonts[style]) {
                const styles = Object.keys(fonts).map(f => `> ${f}`).join('\n');
                return await wasi_sock.sendMessage(wasi_sender, {
                    text: `❌ Unknown style '${style}'.\n\n*Available Styles:*\n${styles}`
                });
            }

            // Update Config
            config.fontStyle = style;

            // Persist to json
            const configPath = path.join(__dirname, '../botConfig.json');
            let currentConfig = {};
            if (fs.existsSync(configPath)) {
                try {
                    currentConfig = JSON.parse(fs.readFileSync(configPath));
                } catch { }
            }
            currentConfig.fontStyle = style;
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));

            await wasi_sock.sendMessage(wasi_sender, {
                text: `✅ Global Font Style updated to: *${style}*`
            });

            // Demo
            const { applyFont } = require('../wasilib/fonts');
            const demoText = applyFont('This is how the new font looks like!', style);
            await wasi_sock.sendMessage(wasi_sender, { text: demoText });

        } catch (e) {
            console.error('SetFont Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
