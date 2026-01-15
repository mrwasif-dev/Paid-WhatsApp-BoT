const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore
} = require('baileys');
const pino = require('pino');

async function wasi_connectSession() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestWaWebVersion();

    const wasi_sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
    });

    return { wasi_sock, saveCreds };
}

module.exports = { wasi_connectSession };
