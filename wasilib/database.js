const mongoose = require('mongoose');



// SCHEMAS
const wasi_toggleSchema = new mongoose.Schema({
    jid: { type: String, required: true },
    command: { type: String, required: true },
    isEnabled: { type: Boolean, default: true }
});

const wasi_userSettingsSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    autoStatusSeen: { type: Boolean, default: false },
    autoStatusReact: { type: Boolean, default: false },
    autoStatusMessage: { type: Boolean, default: false },
    autoTyping: { type: Boolean, default: false },
    autoRecording: { type: Boolean, default: false },
    autoViewOnce: { type: Boolean, default: false }
});

const wasi_autoReplySchema = new mongoose.Schema({
    trigger: { type: String, required: true },
    reply: { type: String, required: true }
});

const wasi_sessionIndexSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now }
});

const wasi_bgmSchema = new mongoose.Schema({
    trigger: { type: String, required: true },
    audioUrl: { type: String, required: true },
    mimetype: { type: String, default: 'audio/mp4' }
});

const wasi_bgmConfigSchema = new mongoose.Schema({
    isEnabled: { type: Boolean, default: true }
});

const wasi_botConfigSchema = new mongoose.Schema({
    prefix: { type: String, default: '.' },
    menuImage: { type: String, default: '' },
    autoRead: { type: Boolean, default: false },
    autoRejectCall: { type: Boolean, default: false },
    welcomeMessage: { type: String, default: '' },
    goodbyeMessage: { type: String, default: '' },
    ownerName: { type: String, default: 'Wasi' },
    sudo: { type: [String], default: [] } // Array of Sudo JIDs
});

let isConnected = false;

// ---------------------------------------------------------------------------
// DYNAMIC MODEL HELPER
// ---------------------------------------------------------------------------
function getModel(sessionId, type) {
    const prefix = sessionId || 'wasi_session';
    // Use dot notation for collection to get folder view in Compass
    const collectionName = `${prefix}.${type.toLowerCase()}`;
    // Model name can be anything unique
    const modelName = `${prefix}_${type}`;

    if (mongoose.models[modelName]) return mongoose.models[modelName];

    switch (type) {
        case 'Toggle': return mongoose.model(modelName, wasi_toggleSchema, collectionName);
        case 'UserSettings': return mongoose.model(modelName, wasi_userSettingsSchema, collectionName);
        case 'AutoReply': return mongoose.model(modelName, wasi_autoReplySchema, collectionName);
        case 'SessionIndex': return mongoose.model(modelName, wasi_sessionIndexSchema, collectionName);
        case 'Bgm': return mongoose.model(modelName, wasi_bgmSchema, collectionName);
        case 'BgmConfig': return mongoose.model(modelName, wasi_bgmConfigSchema, collectionName);
        case 'BotConfig': return mongoose.model(modelName, wasi_botConfigSchema, collectionName);
        default: throw new Error(`Unknown model type: ${type}`);
    }
}
// ...(DB CONNECTION and other existing functions)...

// ---------------------------------------------------------------------------
// BOT CONFIG MANAGEMENT
// ---------------------------------------------------------------------------
async function wasi_getBotConfig(sessionId) {
    if (!isConnected) return null;
    try {
        const Model = getModel(sessionId, 'BotConfig');
        let config = await Model.findOne({});
        if (!config) {
            config = await Model.create({}); // Create defaults if missing
        }
        return config;
    } catch (e) {
        console.error('DB Error getBotConfig:', e);
        return null;
    }
}

async function wasi_updateBotConfig(sessionId, updates) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'BotConfig');
        await Model.findOneAndUpdate({}, updates, { upsert: true, new: true });
        return true;
    } catch (e) {
        console.error('DB Error updateBotConfig:', e);
        return false;
    }
}



// ---------------------------------------------------------------------------
// DB CONNECTION
// ---------------------------------------------------------------------------
async function wasi_connectDatabase(dbUrl) {
    const defaultUrl = 'mongodb+srv://wasidev710_db_user:5xwzp9OQcJkMe1Tu@cluster0.ycj6rnq.mongodb.net/wasidev?retryWrites=true&w=majority&appName=Cluster0';
    const uri = dbUrl || process.env.MONGODB_URI || defaultUrl;

    if (!uri) {
        console.error('❌ FATAL ERROR: No MONGODB_URI found.');
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

// ---------------------------------------------------------------------------
// SESSION MANAGEMENT (Multi-Tenancy)
// ---------------------------------------------------------------------------

async function wasi_registerSession(sessionId) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'SessionIndex');
        await Model.findOneAndUpdate(
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
        const Model = getModel(sessionId, 'SessionIndex');
        await Model.findOneAndDelete({ sessionId });
        return true;
    } catch (e) {
        console.error('DB Error unregisterSession:', e);
        return false;
    }
}

async function wasi_getAllSessions(sessionId) {
    if (!isConnected) return [];
    try {
        // Here we default to the current running session's index
        // or a global index if intended. But for strict isolation,
        // we might only start what this session knows.
        // However, usually "getAllSessions" implies server-level knowledge.
        // If we want total separation, this function might just return the sessionId itself.
        // BUT, for restart handling, we check the specific session's index file.
        const Model = getModel(sessionId, 'SessionIndex');
        const sessions = await Model.find({});
        return sessions.map(s => s.sessionId);
    } catch (e) {
        console.error('DB Error getAllSessions:', e);
        return [];
    }
}

// ---------------------------------------------------------------------------
// BGM MANAGEMENT
// ---------------------------------------------------------------------------

async function wasi_addBgm(sessionId, trigger, audioUrl, mimetype = 'audio/mp4') {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'Bgm');
        await Model.findOneAndUpdate(
            { trigger },
            { trigger, audioUrl, mimetype },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        console.error('DB Error addBgm:', e);
        return false;
    }
}

async function wasi_deleteBgm(sessionId, trigger) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'Bgm');
        const res = await Model.findOneAndDelete({ trigger });
        return !!res;
    } catch (e) {
        console.error('DB Error deleteBgm:', e);
        return false;
    }
}

async function wasi_getBgm(sessionId, trigger) {
    if (!isConnected) return null;
    try {
        const Model = getModel(sessionId, 'Bgm');
        const bgm = await Model.findOne({ trigger });
        // Return object structure
        return bgm ? { url: bgm.audioUrl, mimetype: bgm.mimetype || 'audio/mp4' } : null;
    } catch (e) {
        console.error('DB Error getBgm:', e);
        return null;
    }
}

async function wasi_getAllBgms(sessionId) {
    if (!isConnected) return [];
    try {
        const Model = getModel(sessionId, 'Bgm');
        return await Model.find({});
    } catch (e) {
        console.error('DB Error getAllBgms:', e);
        return [];
    }
}

async function wasi_toggleBgm(sessionId, status) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'BgmConfig');
        await Model.findOneAndUpdate(
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

async function wasi_isBgmEnabled(sessionId) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'BgmConfig');
        const conf = await Model.findOne({});
        return conf ? conf.isEnabled : false;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// COMMANDS / ETC
// ---------------------------------------------------------------------------

async function wasi_isCommandEnabled(sessionId, jid, command) {
    if (!isConnected) return true;
    try {
        const Model = getModel(sessionId, 'Toggle');
        const toggle = await Model.findOne({ jid, command });
        return toggle ? toggle.isEnabled : true;
    } catch (e) {
        console.error('DB Error:', e);
        return true;
    }
}

async function wasi_toggleCommand(sessionId, jid, command, status) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'Toggle');
        await Model.findOneAndUpdate(
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

async function wasi_getUserAutoStatus(sessionId, jid) {
    if (!isConnected) return null;
    try {
        const Model = getModel(sessionId, 'UserSettings');
        const settings = await Model.findOne({ jid });
        return settings;
    } catch (e) {
        console.error('DB Error:', e);
        return null;
    }
}

async function wasi_setUserAutoStatus(sessionId, jid, settings) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'UserSettings');
        await Model.findOneAndUpdate(
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

async function wasi_getAllAutoStatusUsers(sessionId) {
    if (!isConnected) return [];
    try {
        const Model = getModel(sessionId, 'UserSettings');
        const users = await Model.find({ autoStatusSeen: true });
        return users.map(u => u.jid);
    } catch (e) {
        console.error('DB Error:', e);
        return [];
    }
}

async function wasi_getAutoReplies(sessionId) {
    if (!isConnected) return [];
    try {
        const Model = getModel(sessionId, 'AutoReply');
        const replies = await Model.find({});
        return replies.map(r => ({ trigger: r.trigger, reply: r.reply }));
    } catch (e) {
        console.error('DB Error:', e);
        return [];
    }
}

async function wasi_saveAutoReplies(sessionId, replies) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId, 'AutoReply');
        await Model.deleteMany({}); // Clear existing
        if (replies && replies.length > 0) {
            await Model.insertMany(replies);
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
    wasi_saveAutoReplies,
    wasi_registerSession,
    wasi_unregisterSession,
    wasi_getAllSessions,
    wasi_addBgm,
    wasi_deleteBgm,
    wasi_getBgm,
    wasi_getAllBgms,
    wasi_toggleBgm,
    wasi_isBgmEnabled,
    wasi_getBotConfig,
    wasi_updateBotConfig
};
