require('dotenv').config();
const {
    DisconnectReason
} = require('baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { wasi_connectSession } = require('./wasilib/session');
const { wasi_connectDatabase, wasi_isCommandEnabled } = require('./wasilib/database');
const config = require('./wasi');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

// Load Plugins
const wasi_plugins = new Map();
function wasi_loadPlugins() {
    const pluginDir = path.join(__dirname, 'wasiplugins');
    if (!fs.existsSync(pluginDir)) return;

    const files = fs.readdirSync(pluginDir);
    for (const file of files) {
        if (file.endsWith('.js')) {
            const plugin = require(`./wasiplugins/${file}`);
            if (plugin.name) {
                wasi_plugins.set(plugin.name, plugin);
                if (plugin.aliases && Array.isArray(plugin.aliases)) {
                    plugin.aliases.forEach(alias => wasi_plugins.set(alias, plugin));
                }
            }
        }
    }
}

wasi_app.get('/', (req, res) => {
    res.send('Wasi WhatsApp Bot with Modules is running!');
});

function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`Wasi Server is running on port ${wasi_port}`);
    });
}

async function wasi_startBot() {
    await wasi_connectDatabase();
    const { wasi_sock, saveCreds } = await wasi_connectSession();

    wasi_sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Wasi Bot: Scan this QR Code to connect:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const wasi_shouldReconnect = (lastDisconnect.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('Wasi Bot: Connection closed, reconnecting: ', wasi_shouldReconnect);
            if (wasi_shouldReconnect) {
                wasi_startBot();
            }
        } else if (connection === 'open') {
            console.log('Wasi Bot: Connected successfully!');
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    // -------------------------------------------------------------------------
    // AUTO STATUS SEEN + REACT + MESSAGE
    // -------------------------------------------------------------------------
    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        const wasi_msg = wasi_m.messages[0];
        if (!wasi_msg.message) return;

        const wasi_sender = wasi_msg.key.remoteJid;

        // Auto Status Seen Feature
        if (wasi_sender === 'status@broadcast') {
            try {
                const statusOwner = wasi_msg.key.participant;
                const { wasi_getUserAutoStatus } = require('./wasilib/database');

                // Check if status owner has enabled auto status in database
                const userSettings = await wasi_getUserAutoStatus(statusOwner);
                const shouldAutoView = userSettings?.autoStatusSeen || config.autoStatusSeen;

                if (!shouldAutoView) return;

                // Mark status as read
                await wasi_sock.readMessages([wasi_msg.key]);
                console.log(`Auto viewed status from: ${statusOwner}`);

                // React with heart (check user settings first, then global config)
                const shouldReact = userSettings?.autoStatusReact ?? config.autoStatusReact;
                if (shouldReact) {
                    await wasi_sock.sendMessage(wasi_sender, {
                        react: { text: '❤️', key: wasi_msg.key }
                    }, { statusJidList: [statusOwner] });
                }

                // Send message to user (check user settings first, then global config)
                const shouldMessage = userSettings?.autoStatusMessage ?? config.autoStatusMessage;
                if (shouldMessage) {
                    await wasi_sock.sendMessage(statusOwner, {
                        text: `👁️ Your status has been seen by *${config.botName}*!`
                    });
                }
            } catch (e) {
                console.error('Auto status error:', e.message);
            }
            return;
        }

        // Auto Read Messages
        if (config.autoReadMessages && !wasi_msg.key.fromMe) {
            try {
                await wasi_sock.readMessages([wasi_msg.key]);
            } catch (e) { /* ignore */ }
        }

        const wasi_text = wasi_msg.message.conversation ||
            wasi_msg.message.extendedTextMessage?.text ||
            wasi_msg.message.imageMessage?.caption || "";

        if (wasi_text.startsWith(config.prefix)) {
            const wasi_parts = wasi_text.slice(config.prefix.length).trim().split(' ');
            const wasi_cmd_input = wasi_parts[0].toLowerCase();
            const wasi_args = wasi_parts.slice(1).join(' ');

            console.log(`Command detected: ${wasi_cmd_input}`);

            if (wasi_plugins.has(wasi_cmd_input)) {
                // Check if command is enabled
                const isEnabled = await wasi_isCommandEnabled(wasi_sender, wasi_cmd_input);
                if (!isEnabled) {
                    console.log(`Command ${wasi_cmd_input} is disabled in ${wasi_sender}`);
                    return;
                }

                // Show presence based on user settings or global config
                const { wasi_getUserAutoStatus } = require('./wasilib/database');
                const userPresenceSettings = await wasi_getUserAutoStatus(wasi_sender);
                const shouldType = userPresenceSettings?.autoTyping ?? config.autoTyping;
                const shouldRecord = userPresenceSettings?.autoRecording ?? config.autoRecording;

                if (shouldRecord) {
                    await wasi_sock.sendPresenceUpdate('recording', wasi_sender);
                } else if (shouldType) {
                    await wasi_sock.sendPresenceUpdate('composing', wasi_sender);
                }

                console.log(`Executing plugin: ${wasi_cmd_input}`);
                const plugin = wasi_plugins.get(wasi_cmd_input);

                // Check if command is owner-only
                if (plugin.ownerOnly) {
                    const senderNumber = wasi_sender.replace('@s.whatsapp.net', '').replace('@lid', '');
                    const isOwner = senderNumber.includes(config.ownerNumber) || wasi_msg.key.fromMe;
                    if (!isOwner) {
                        return wasi_sock.sendMessage(wasi_sender, {
                            text: '❌ *Access Denied!*\n\nYou are not the owner. Only the bot owner can use this command.'
                        });
                    }
                }
                try {
                    await plugin.wasi_handler(wasi_sock, wasi_sender, {
                        wasi_plugins,
                        wasi_args,
                        wasi_msg,
                        wasi_text
                    });
                } catch (e) {
                    console.error('Error in plugin:', e);
                }

                // Stop presence after execution
                await wasi_sock.sendPresenceUpdate('paused', wasi_sender);
            } else {
                console.log('Command not found in plugins');
            }
        }
    });
}

wasi_loadPlugins();
wasi_startServer();
wasi_startBot();
