// src/config/sections/db.config.ts

export interface DbSectionConfig {
  db: {
    uri: string;
    validate: () => boolean;
  };
}

// Export a function that will be called after env vars are loaded
const dbConfig: DbSectionConfig = {
  db: {
    uri: process.env.MONGO_URI || '',

    // Validate method to be called after environment variables are loaded
    validate(): boolean {
      if (!this.uri) {
        throw new Error('MONGO_URI is not defined in environment variables');
      }
      return true;
    },
  },
};

export default dbConfig;
