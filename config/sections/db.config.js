// src/config/sections/db.config.js
import { getEnv } from '../utils.js'; 

// Export a function that will be called after env vars are loaded
const dbConfig = {
  db: {
    uri: process.env.MONGO_URI || '',
    
    // Validate method to be called after environment variables are loaded
    validate: function() {
      if (!this.uri) {
        throw new Error('MONGO_URI is not defined in environment variables');
      }
      return true;
    }
  }
};

export default dbConfig;