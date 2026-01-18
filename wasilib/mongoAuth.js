const mongoose = require('mongoose');

// Define Schema for Auth
const AuthStateSchema = new mongoose.Schema({
    _id: String,
    data: Object
});

// Remove global model definition
// const AuthState = mongoose.model('AuthState', AuthStateSchema);

const useMongoDBAuthState = async (collectionName = 'auth_info_baileys') => {
    // Dynamic Model
    const ModelName = `${collectionName}_AuthState`;
    let AuthState;
    try {
        AuthState = mongoose.model(ModelName);
    } catch {
        AuthState = mongoose.model(ModelName, AuthStateSchema);
    }

    // 1. Write Data
    const writeData = async (data, id) => {
        try {
            await AuthState.findOneAndUpdate(
                { _id: id },
                { data: data },
                { upsert: true, new: true }
            );
        } catch (error) {
            console.error('Error writing auth state to DB:', error);
        }
    };

    // 2. Read Data
    const readData = async (id) => {
        try {
            const result = await AuthState.findById(id);
            return result ? result.data : null;
        } catch (error) {
            console.error('Error reading auth state from DB:', error);
            return null;
        }
    };

    // 3. Remove Data
    const removeData = async (id) => {
        try {
            await AuthState.findByIdAndDelete(id);
        } catch (error) {
            console.error('Error removing auth state from DB:', error);
        }
    };

    // 4. Initialize Creds
    const creds = await readData('creds') || (require('@whiskeysockets/baileys')).initAuthCreds();

    // 5. Clear All Data (for logout/reset)
    const clearAllData = async () => {
        try {
            await AuthState.deleteMany({});
        } catch (error) {
            console.error('Error clearing auth state from DB:', error);
        }
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').BufferJSON.reviver(null, value);
                        }
                        if (value) data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearState: clearAllData
    };
};

module.exports = { useMongoDBAuthState };
