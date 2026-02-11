require('dotenv').config();

module.exports = {
    sessionId: process.env.SESSION_ID || '',
    mongoDbUrl: process.env.MONGODB_URI || process.env.MONGODB_URL || '',
};


const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const OLD_TEXT_REGEX = /™✤͜🤍⃛⃟🇫.*?ʏ☆🇭.*?🏠/gu;
const NEW_TEXT = '💫 WA Social ~ Network ™  📡';

const replaceCaption = (caption) => {
    if (!caption) return caption;
    return caption.replace(OLD_TEXT_REGEX, NEW_TEXT);
};
