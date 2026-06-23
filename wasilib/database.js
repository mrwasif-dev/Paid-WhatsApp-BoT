const mongoose = require('mongoose');

// ============================================
// SESSION SCHEMA - صرف سیشن ٹریک کرنے کے لیے
// ============================================

const wasi_sessionIndexSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now }
});

let isConnected = false;

// ============================================
// DYNAMIC MODEL HELPER
// ============================================

function getModel(sessionId) {
    const prefix = sessionId || 'wasi_session';
    const collectionName = `${prefix}.sessionindex`;
    const modelName = `${prefix}_SessionIndex`;

    if (mongoose.models[modelName]) return mongoose.models[modelName];
    
    return mongoose.model(modelName, wasi_sessionIndexSchema, collectionName);
}

// ============================================
// DATABASE CONNECTION
// ============================================

async function wasi_connectDatabase(dbUrl) {
    const uri = dbUrl || process.env.MONGODB_URI;

    if (!uri) {
        console.error('❌ No MONGODB_URI found.');
        return false;
    }

    try {
        await mongoose.connect(uri);
        isConnected = true;
        console.log('✅ Database connected successfully!');
        return true;
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        return false;
    }
}

function wasi_isDbConnected() {
    return isConnected;
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function wasi_registerSession(sessionId) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId);
        await Model.findOneAndUpdate(
            { sessionId },
            { sessionId },
            { upsert: true, new: true }
        );
        console.log(`✅ Session "${sessionId}" registered in database`);
        return true;
    } catch (e) {
        console.error('DB Error registerSession:', e);
        return false;
    }
}

async function wasi_unregisterSession(sessionId) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId);
        await Model.findOneAndDelete({ sessionId });
        console.log(`✅ Session "${sessionId}" unregistered from database`);
        return true;
    } catch (e) {
        console.error('DB Error unregisterSession:', e);
        return false;
    }
}

async function wasi_getAllSessions(sessionId) {
    if (!isConnected) return [];
    try {
        const Model = getModel(sessionId);
        const sessions = await Model.find({});
        return sessions.map(s => s.sessionId);
    } catch (e) {
        console.error('DB Error getAllSessions:', e);
        return [];
    }
}

async function wasi_sessionExists(sessionId) {
    if (!isConnected) return false;
    try {
        const Model = getModel(sessionId);
        const session = await Model.findOne({ sessionId });
        return !!session;
    } catch (e) {
        console.error('DB Error sessionExists:', e);
        return false;
    }
}

// ============================================
// EXPORTS - صرف ضروری فنکشنز
// ============================================

module.exports = {
    wasi_connectDatabase,
    wasi_isDbConnected,
    wasi_registerSession,
    wasi_unregisterSession,
    wasi_getAllSessions,
    wasi_sessionExists
};
