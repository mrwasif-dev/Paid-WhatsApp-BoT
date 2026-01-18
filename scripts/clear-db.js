require('dotenv').config();
const mongoose = require('mongoose');

const mongoUrl = process.env.MONGODB_URI;

if (!mongoUrl) {
    console.error('❌ MONGODB_URI not found in .env');
    process.exit(1);
}

async function clearDatabase() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(mongoUrl);
        console.log('✅ Connected.');

        const collections = await mongoose.connection.db.collections();

        if (collections.length === 0) {
            console.log('⚠️ Database is already empty.');
            process.exit(0);
        }

        console.log(`🗑️ Found ${collections.length} collections. Clearing...`);

        for (let collection of collections) {
            console.log(`   - Dropping ${collection.collectionName}`);
            await collection.drop();
        }

        console.log('✨ All collections dropped successfully!');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error clearing database:', error);
        process.exit(1);
    }
}

// Confirmation Prompt logic is hard in non-interactive script usually, 
// so we just run it. Use with caution.
clearDatabase();
