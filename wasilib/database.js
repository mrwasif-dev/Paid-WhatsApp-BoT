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

const WasiToggle = mongoose.model('WasiToggle', wasi_toggleSchema);
const WasiUserSettings = mongoose.model('WasiUserSettings', wasi_userSettingsSchema);

// Auto Reply Schema
const wasi_autoReplySchema = new mongoose.Schema({
    trigger: { type: String, required: true },
    reply: { type: String, required: true }
});
const WasiAutoReply = mongoose.model('WasiAutoReply', wasi_autoReplySchema);

let isConnected = false;

async function wasi_connectDatabase() {
    if (!process.env.MONGODB_URI) {
        console.log('Wasi Bot: No MONGODB_URI found in .env. Database features will be disabled.');
        return;
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        isConnected = true;
        console.log('Wasi Bot: Connected to MongoDB successfully!');
    } catch (err) {
        console.error('Wasi Bot: Failed to connect to MongoDB:', err.message);
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

module.exports = {
    wasi_connectDatabase,
    wasi_isDbConnected,
    wasi_isCommandEnabled,
    wasi_toggleCommand,
    wasi_getUserAutoStatus,
    wasi_setUserAutoStatus,
    wasi_getAllAutoStatusUsers,
    wasi_getAutoReplies,
    wasi_saveAutoReplies
};
