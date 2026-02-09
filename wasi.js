const config = {
    sessionId: process.env.SESSION_ID || '',
    mongoDbUrl: process.env.MONGODB_URI || '',
    ownerNumber: process.env.OWNER_NUMBER || '923039107958@s.whatsapp.net',
    prefix: process.env.PREFIX || '!'
};

module.exports = { config };
