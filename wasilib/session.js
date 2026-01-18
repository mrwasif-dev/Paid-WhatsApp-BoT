const {
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    makeWASocket,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('../wasi');
const { useMongoDBAuthState } = require('./mongoAuth');

async function wasi_connectSession(usePairingCode = false) {
    // -------------------------------------------------------------------------
    // Use MongoDB Auth State directly
    // This removes the dependency on the local file system which is ephemeral on Heroku.
    // -------------------------------------------------------------------------
    const { state, saveCreds } = await useMongoDBAuthState(config.sessionId);

    let version;
    try {
        const v = await fetchLatestWaWebVersion();
        version = v.version;
    } catch (e) {
        version = [2, 3000, 1015901307];
    }

    const socketOptions = {
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            // Wrap keys with makeCacheableSignalKeyStore for better performance
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        retryRequestDelayMs: 5000,
        keepAliveIntervalMs: 10000,
        connectTimeoutMs: 60000,
    };

    const wasi_sock = makeWASocket(socketOptions);

    return { wasi_sock, saveCreds };
}

async function wasi_clearSession() {
    const { useMongoDBAuthState } = require('./mongoAuth');
    // We need to instantiate it to get the clearState method, or we could make clearState static?
    // useMongoDBAuthState initializes the model.
    // If we just want to delete the collection data:
    const { clearState } = await useMongoDBAuthState(config.sessionId);
    if (clearState) {
        await clearState();
        console.log('Session cleared from MongoDB');
    }
}

module.exports = { wasi_connectSession, wasi_clearSession };
