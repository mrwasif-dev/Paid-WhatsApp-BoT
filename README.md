# WASI-MD V7 🤖
> **Powerful WhatsApp Multi-Device Bot with Web Dashboard**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Baileys-25D366.svg)](https://github.com/WhiskeySockets/Baileys)
[![Heroku](https://img.shields.io/badge/Deploy-Heroku%20Docker-purple.svg)](https://heroku.com)

WASI-MD V7 is a feature-rich WhatsApp bot designed for ease of use. It features a fully integrated **Web Dashboard** for configuration, pairing, and management, eliminating the need for complex environment variable setups.

---

## 🌟 Key Features

### 🖥️ Web Dashboard
- **Visual Configuration:** No more editing files! Configure Bot Name, Owner, Prefix, and Features directly from the UI.
- **Easy Pairing:** Connect using **Pairing Code** (recommended) or QR Code.
- **Status Monitoring:** Real-time connection and database status.

### ⚙️ Automation & Tools
- **Auto Replies:** Create custom trigger/reply rules via the Dashboard.
- **Auto Status:** Automatically view status updates and react with ❤️.
- **Auto Read:** Optional blue ticks for all messages.
- **Media Tools:** 
  - `vv`: Retrieve/Download "View Once" images and videos.
  - `sticker`: Create stickers from images/videos.
  - `setpp`: Update bot profile picture.
  - `setbio`: Update bot status/bio.
- **Cloud Sync:** Connect **MongoDB** to sync your settings and auto-replies across restarts/deployments.

---

## 🚀 Deployment Guide

### Option 1: Heroku (Docker) - Recommended for 24/7
This bot uses a `Dockerfile` for stable deployment.

1.  **Install & Login**
    - Install [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli).
    - Login to your account:
        ```bash
        heroku login
        heroku container:login
        ```
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/Itxxwasi/WASI-MD-V7)

2.  **Create App**
    ```bash
    heroku create your-unique-app-name
    ```

3.  **Deploy**
    Push the Docker image to Heroku:
    ```bash
    heroku container:push web -a your-unique-app-name
    heroku container:release web -a your-unique-app-name
    ```

4.  **Open Dashboard**
    ```bash
    heroku open -a your-unique-app-name
    ```
    *Go to the URL, Pair your WhatsApp, and Configure your bot!*

    > **Important:** For settings to persist on Heroku (which restarts daily), you **MUST** configure a **MongoDB URI** in the dashboard.

### Option 2: Local / VPS
1.  **Clone & Install**
    ```bash
    git clone https://github.com/Itxxwasi/new-bot.git
    cd new-bot
    npm install
    ```
2.  **Start**
    ```bash
    npm start
    ```
3.  **Use**
    Open `http://localhost:3000` in your browser.

---

## 📝 Configuration

All configuration is done via the **"⚙️ Configure"** button on the dashboard:

| Setting | Description |
| :--- | :--- |
| **Bot Name** | Name displayed in menus. |
| **Owner Number** | Your WhatsApp number (for owner commands). |
| **MongoDB URI** | Connection string for cloud backup (Atlas). |
| **Auto Features** | Toggle Auto Read, Type, Recording, Status View, etc. |
| **Auto Replies** | Add custom keyword triggers and responses. |

---

## 🛠️ Commands List

| Command | Usage | Description |
| :--- | :--- | :--- |
| `.menu` | `.menu` | Show the bot menu. |
| `.vv` | Reply to ViewOnce with `.vv` | Retrieve and resend View Once media. |
| `.sticker` | Reply to image with `.sticker` | Create a sticker. |
| `.setpp` | Reply to image with `.setpp` | Update bot profile photo. |
| `.setbio` | `.setbio <text>` | Update WhatsApp About/Bio. |
| `.ping` | `.ping` | Check bot response speed. |
| `.eval` | `.eval <code >` | (Owner Only) Execute JavaScript. |

---

## 📁 project Structure
```
├── public/             # Web Dashboard (HTML/CSS/JS)
├── wasilib/            # Core libraries (Session, DB, Helpers)
├── wasiplugins/        # Command plugins
├── index.js            # Main entry point & API routes
├── Dockerfile          # Heroku Docker config
└── botConfig.json      # Local config storage
```

---
© 2026 WASI-MD V7 | Developed by @Itxxwasi
