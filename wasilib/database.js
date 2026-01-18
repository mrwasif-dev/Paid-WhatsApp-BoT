const mongoose = require('mongoose');

// Command Toggle Schema
const wasi_toggleSchema = new mongoose.Schema({
    jid: { type: String, required: true },
    command: { type: String, required: true },
    isEnabled: { type: Boolean, default: true }
});

// User Settings Schema
const wasi_userSettingsSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    autoStatusSeen: { type: Boolean, default: false },
    autoStatusReact: { type: Boolean, default: false },
    autoStatusMessage: { type: Boolean, default: false },
    autoTyping: { type: Boolean, default: false },
    autoRecording: { type: Boolean, default: false },
    autoViewOnce: { type: Boolean, default: false }
});

const config = require('../wasi');
const SESSION_PREFIX = config.sessionId || 'wasi_session';

const WasiToggle = mongoose.models[`${SESSION_PREFIX}_Toggle`] || mongoose.model(`${SESSION_PREFIX}_Toggle`, wasi_toggleSchema);
const WasiUserSettings = mongoose.models[`${SESSION_PREFIX}_UserSettings`] || mongoose.model(`${SESSION_PREFIX}_UserSettings`, wasi_userSettingsSchema);

// Auto Reply Schema
const wasi_autoReplySchema = new mongoose.Schema({
    trigger: { type: String, required: true },
    reply: { type: String, required: true }
});
const WasiAutoReply = mongoose.models[`${SESSION_PREFIX}_AutoReply`] || mongoose.model(`${SESSION_PREFIX}_AutoReply`, wasi_autoReplySchema);

// Session Index Schema (to track multiple users)
const wasi_sessionIndexSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now }
});
const WasiSessionIndex = mongoose.models[`${SESSION_PREFIX}_SessionIndex`] || mongoose.model(`${SESSION_PREFIX}_SessionIndex`, wasi_sessionIndexSchema);

// BGM Schema
const wasi_bgmSchema = new mongoose.Schema({
    trigger: { type: String, required: true }, // The word to trigger
    audioUrl: { type: String, required: true }  // The audio file URL
});
const WasiBgm = mongoose.models[`${SESSION_PREFIX}_Bgm`] || mongoose.model(`${SESSION_PREFIX}_Bgm`, wasi_bgmSchema);

// BGM Config Schema (Global On/Off)
const wasi_bgmConfigSchema = new mongoose.Schema({
    isEnabled: { type: Boolean, default: true }
});
const WasiBgmConfig = mongoose.models[`${SESSION_PREFIX}_BgmConfig`] || mongoose.model(`${SESSION_PREFIX}_BgmConfig`, wasi_bgmConfigSchema);

let isConnected = false;

// ---------------------------------------------------------------------------
// SESSION MANAGEMENT (Multi-Tenancy)
// ---------------------------------------------------------------------------

async function wasi_registerSession(sessionId) {
    if (!isConnected) return false;
    try {
        await WasiSessionIndex.findOneAndUpdate(
            { sessionId },
            { sessionId },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error registerSession:', e);
        return false;
    }
}

async function wasi_unregisterSession(sessionId) {
    if (!isConnected) return false;
    try {
        await WasiSessionIndex.findOneAndDelete({ sessionId });
        return true;
    } catch (e) {
        console.error('DB Error unregisterSession:', e);
        return false;
    }
}

async function wasi_getAllSessions() {
    if (!isConnected) return [];
    try {
        const sessions = await WasiSessionIndex.find({});
        return sessions.map(s => s.sessionId);
    } catch (e) {
        console.error('DB Error getAllSessions:', e);
        return [];
    }
}

// ---------------------------------------------------------------------------
// BGM MANAGEMENT
// ---------------------------------------------------------------------------

async function wasi_addBgm(trigger, audioUrl) {
    if (!isConnected) return false;
    try {
        await WasiBgm.findOneAndUpdate(
            { trigger },
            { trigger, audioUrl },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error addBgm:', e);
        return false;
    }
}

async function wasi_deleteBgm(trigger) {
    if (!isConnected) return false;
    try {
        const res = await WasiBgm.findOneAndDelete({ trigger });
        return !!res;
    } catch (e) {
        console.error('DB Error deleteBgm:', e);
        return false;
    }
}

async function wasi_getBgm(trigger) {
    if (!isConnected) return null;
    try {
        // Simple exact match or partial? User said "check filter words if detect in chat".
        // Usually regex search is better for detection, but here we likely look up specific triggers.
        // For detection loop, we might need getAllBgms.
        const bgm = await WasiBgm.findOne({ trigger });
        return bgm ? bgm.audioUrl : null;
    } catch (e) {
        console.error('DB Error getBgm:', e);
        return null;
    }
}

async function wasi_getAllBgms() {
    if (!isConnected) return [];
    try {
        return await WasiBgm.find({});
    } catch (e) {
        console.error('DB Error getAllBgms:', e);
        return [];
    }
}

async function wasi_toggleBgm(status) {
    if (!isConnected) return false;
    try {
        await WasiBgmConfig.findOneAndUpdate(
            {},
            { isEnabled: status },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error toggleBgm:', e);
        return false;
    }
}

async function wasi_isBgmEnabled() {
    if (!isConnected) return false;
    try {
        const conf = await WasiBgmConfig.findOne({});
        return conf ? conf.isEnabled : false; // Default off if not set? User said ".bgm on/off", usually implies default state. Let's say default off safely.
    } catch (e) {
        return false;
    }
}

module.exports = {
    wasi_connectDatabase,
    wasi_isDbConnected,
    wasi_isCommandEnabled,
    wasi_toggleCommand,
    wasi_getUserAutoStatus,
    wasi_setUserAutoStatus,
    wasi_getAllAutoStatusUsers,
    wasi_getAutoReplies,
    wasi_saveAutoReplies,
    wasi_registerSession,
    wasi_unregisterSession,
    wasi_getAllSessions,
    wasi_addBgm,
    wasi_deleteBgm,
    wasi_getBgm,
    wasi_getAllBgms,
    wasi_toggleBgm,
    wasi_isBgmEnabled
};

async function wasi_connectDatabase(dbUrl) {
    const defaultUrl = 'mongodb+srv://wasidev710_db_user:5xwzp9OQcJkMe1Tu@cluster0.ycj6rnq.mongodb.net/wasidev?retryWrites=true&w=majority&appName=Cluster0';
    const uri = dbUrl || process.env.MONGODB_URI || defaultUrl;

    if (!uri) {
        console.error('❌ FATAL ERROR: No MONGODB_URI found.');
        console.error('   Please add MONGODB_URI to your .env file or Heroku Config Vars.');
        console.error('   The bot cannot run without a database connection in this mode.');
        return false;
    }

    try {
        await mongoose.connect(uri);
        isConnected = true;
        console.log('✅ Wasi Bot: Connected to MongoDB successfully!');
        return true;
    } catch (err) {
        console.error('❌ Wasi Bot: Failed to connect to MongoDB:', err.message);
        return false;
    }
}

function wasi_isDbConnected() {
    return isConnected;
}

async function wasi_isCommandEnabled(jid, command) {
    if (!isConnected) return true;

    try {
        const toggle = await WasiToggle.findOne({ jid, command });
        return toggle ? toggle.isEnabled : true;
    } catch (e) {
        console.error('DB Error:', e);
        return true;
    }
}

async function wasi_toggleCommand(jid, command, status) {
    if (!isConnected) return false;

    try {
        await WasiToggle.findOneAndUpdate(
            { jid, command },
            { isEnabled: status },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error:', e);
        return false;
    }
}

// Get user auto status settings
async function wasi_getUserAutoStatus(jid) {
    if (!isConnected) return null;

    try {
        const settings = await WasiUserSettings.findOne({ jid });
        return settings;
    } catch (e) {
        console.error('DB Error:', e);
        return null;
    }
}

// Set user auto status settings
async function wasi_setUserAutoStatus(jid, settings) {
    if (!isConnected) return false;

    try {
        await WasiUserSettings.findOneAndUpdate(
            { jid },
            settings,
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error:', e);
        return false;
    }
}

// Get all users with auto status enabled
async function wasi_getAllAutoStatusUsers() {
    if (!isConnected) return [];

    try {
        const users = await WasiUserSettings.find({ autoStatusSeen: true });
        return users.map(u => u.jid);
    } catch (e) {
        console.error('DB Error:', e);
        return [];
    }
}

// Get all auto replies
async function wasi_getAutoReplies() {
    if (!isConnected) return [];
    try {
        const replies = await WasiAutoReply.find({});
        return replies.map(r => ({ trigger: r.trigger, reply: r.reply }));
    } catch (e) {
        console.error('DB Error:', e);
        return [];
    }
}

// Save all auto replies (overwrite)
async function wasi_saveAutoReplies(replies) {
    if (!isConnected) return false;
    try {
        await WasiAutoReply.deleteMany({}); // Clear existing
        if (replies && replies.length > 0) {
            await WasiAutoReply.insertMany(replies);
        }
        return true;
    } catch (e) {
        console.error('DB Error:', e);
        return false;
    }
}


