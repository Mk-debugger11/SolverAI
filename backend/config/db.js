const mongoose = require('mongoose');

async function connectDb(uri) {
  const mongoUri = uri || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dom_fetcher';
  try {
    await mongoose.connect(mongoUri);
    console.log(` MongoDB connected successfully: ${mongoUri}`);
    return true;
  } catch (err) {
    console.error(' MongoDB connection failed:', err.message);
    console.log(' Running without persistent database connection...');
    return false;
  }
}

module.exports = { connectDb };
