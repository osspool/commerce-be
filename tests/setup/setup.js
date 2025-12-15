import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

let mongoServer;

// Start MongoDB Memory Server before all tests
beforeAll(async () => {
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

  await mongoose.connect(uri);

  console.log(`\n✓ MongoDB Memory Server started: ${uri}\n`);
});

// Clean up after all tests
afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  if (mongoServer) {
    await mongoServer.stop();
    console.log('\n✓ MongoDB Memory Server stopped\n');
  }
});

// Clear all collections before each test for isolation
beforeEach(async () => {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;

    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
});

// Optional: Clear after each test as well
afterEach(async () => {
  // Can add cleanup logic here if needed
});

// Export helper for getting test database
export function getTestDb() {
  return mongoose.connection.db;
}

// Helper to create test models
export async function createTestModel(Model, data) {
  return await Model.create(data);
}

// Helper to clear specific collection
export async function clearCollection(collectionName) {
  if (mongoose.connection.readyState === 1) {
    const collection = mongoose.connection.collections[collectionName];
    if (collection) {
      await collection.deleteMany({});
    }
  }
}
