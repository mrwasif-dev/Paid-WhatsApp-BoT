# WASI-MD-V7 Plugins 🔌

This folder is the heart of the bot. Every single file here is a command that the bot can perform. I've designed it specifically so that adding new features is as easy as dropping a new `.js` file in here.

### How it works? 🧠
The bot's main engine automatically scans this folder when it starts up. It looks for a specific structure (name, alias, category, and the handler function) and registers them. If you want to change how a command works or what it says, you just edit the file here and restart your bot.

### What's inside? 📂
I've categorized the plugins to keep things organized:
- **General/Main:** Essential stuff like `menu.js`, `alive.js`, and `ping.js`.
- **Downloaders:** The heavy hitters like `youtube.js`, `tiktok.js`, `instagram.js`, and the newly added `pinterest.js`.
- **Group Management:** Tools to keep groups clean—`kick.js`, `promote.js`, `antilink.js`, and the power-user `autoforward.js`.
- **Media/Tools:** Fancy text, background music (bgm), stickers, and specialized search tools.

### Friendly Reminder 💡
If you're making your own command:
1. Make sure the filename is unique.
2. Don't forget to export the module.
3. If you mess up the code, the bot might show an error in the logs, so keep an eye on your terminal!

---
*Created with love by MR WASI DEV*
