/**
 * Global Setup - Runs once before all tests
 * Starts MongoDB Memory Server
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer;

export async function setup() {
  // Start MongoDB Memory Server
  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: 'test-bigboss',
    },
  });

  const uri = mongoServer.getUri();

  // Close existing connection if any
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // Connect to MongoDB Memory Server
  await mongoose.connect(uri);

  console.log(`\n✓ MongoDB Memory Server started: ${uri}\n`);

  // Store URI in global for access by tests
  globalThis.__MONGO_URI__ = uri;
  globalThis.__MONGO_SERVER__ = mongoServer;
}

export async function teardown() {
  // Disconnect mongoose
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // Stop MongoDB Memory Server
  if (globalThis.__MONGO_SERVER__) {
    await globalThis.__MONGO_SERVER__.stop();
    console.log('\n✓ MongoDB Memory Server stopped\n');
  }
}
