/**
 * Test Setup - Runs when each test file is loaded
 * Ensures mongoose connection and exports cleanup utilities
 */

import mongoose from 'mongoose';

// Ensure mongoose is connected before tests
if (mongoose.connection.readyState === 0 && globalThis.__MONGO_URI__) {
  await mongoose.connect(globalThis.__MONGO_URI__);
}

// Export cleanup function that tests can use
export async function clearAllCollections() {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;

    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}
