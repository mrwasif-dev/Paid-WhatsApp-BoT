# 🤖 WASI-MD-V7

A powerful WhatsApp Bot built with Node.js and Baileys.

## ✨ Features

- 🔌 Modular plugin system
- 🗄️ MongoDB integration for user settings
- 👁️ Auto status viewing with reactions
- ⌨️ Auto typing/recording indicators
- 🔐 Owner-only command protection
- 📦 Easy deployment (Docker, Heroku, PM2)

## 🚀 Deployment Options

### Option 1: Local with NPM
```bash
npm install
npm start
```

### Option 2: Local with PM2
```bash
npm install
npm install -g pm2
pm2 start ecosystem.config.json
```

### Option 3: Docker
```bash
docker build -t wasi-bot .
docker run -d --name wasi-bot -p 3000:3000 --env-file .env wasi-bot
```

### Option 4: Heroku
[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/Itxxwasi/WASI-MD-V7)

1. Click the Deploy button above
2. Set environment variables in Heroku dashboard
3. Deploy!

### Option 5: Railway / Render / Fly.io
These platforms auto-detect the Dockerfile. Just connect your GitHub repo!

## ⚙️ Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `BOT_NAME` | Bot display name | No |
| `MODE` | public or private | No |
| `OWNER_NUMBER` | Your WhatsApp number | No |
| `MONGODB_URI` | MongoDB connection string | No |
| `BOT_MENU_IMAGE_URL` | Menu image URL | No |

## 📁 Project Structure

```
├── index.js           # Main entry point
├── wasi.js            # Bot configuration
├── wasilib/           # Core library modules
│   ├── session.js     # WhatsApp session handler
│   ├── database.js    # MongoDB integration
│   ├── datatype.js    # Buffer type detection
│   └── fetch.js       # HTTP utilities
├── wasiplugins/       # Command plugins
│   ├── menu.js        # Menu command
│   ├── ping.js        # Ping command
│   ├── alive.js       # Alive command
│   ├── status.js      # Auto status toggle
│   ├── typing.js      # Auto typing toggle
│   ├── recording.js   # Auto recording toggle
│   └── ...            # More plugins
├── Dockerfile         # Docker configuration
├── Procfile           # Heroku configuration
└── ecosystem.config.json  # PM2 configuration
```

## 📝 Commands

### General
- `.menu` - Show all commands
- `.ping` - Check bot response
- `.alive` - Check if bot is alive
- `.jid` - Get chat JID

### Settings (Owner Only)
- `.status on/off` - Toggle auto status viewing
- `.typing on/off` - Toggle typing indicator
- `.recording on/off` - Toggle recording indicator
- `.toggle <cmd> on/off` - Enable/disable commands

### Group (Admin)
- `.add <number>` - Add member to group
- `.kick @user` - Remove member from group

## 👨‍💻 Author

**Waseem** - [@Itxxwasi](https://github.com/Itxxwasi)

## 📄 License

MIT License
