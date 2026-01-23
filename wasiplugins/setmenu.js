const config = require('../wasi');
const { designs } = require('../wasilib/menus');
const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'setmenu',
    category: 'Settings',
    desc: 'Change the menu layout design',
    ownerOnly: true,
    wasi_handler: async (wasi_sock, wasi_sender, { wasi_args }) => {
        try {
            if (!wasi_args || wasi_args.length === 0) {
                const styles = Object.keys(designs).map(f => `> ${f}`).join('\n');
                return await wasi_sock.sendMessage(wasi_sender, {
                    text: `📐 *Available Menu Styles:*\n\n${styles}\n\nUsage: .setmenu <style>`
                });
            }

            const style = wasi_args[0].toLowerCase();
            if (!designs[style]) {
                const styles = Object.keys(designs).map(f => `> ${f}`).join('\n');
                return await wasi_sock.sendMessage(wasi_sender, {
                    text: `❌ Unknown style '${style}'.\n\n*Available Styles:*\n${styles}`
                });
            }

            // Update Config
            config.menuStyle = style;

            // Persist to json
            const configPath = path.join(__dirname, '../botConfig.json');
            let currentConfig = {};
            if (fs.existsSync(configPath)) {
                try {
                    currentConfig = JSON.parse(fs.readFileSync(configPath));
                } catch { }
            }
            currentConfig.menuStyle = style;
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));

            await wasi_sock.sendMessage(wasi_sender, {
                text: `✅ Menu Style updated to: *${style}*`
            });

        } catch (e) {
            console.error('SetMenu Error:', e);
            await wasi_sock.sendMessage(wasi_sender, { text: `❌ Error: ${e.message}` });
        }
    }
};
