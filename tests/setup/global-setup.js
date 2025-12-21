/**
 * Global Setup - Runs once before all tests
 * Starts MongoDB Memory Server
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer;

export async function setup() {
  // Load RedX sandbox credentials from `.env.dev` when available.
  // We intentionally only map RedX keys to avoid pulling in dev/prod secrets (JWT, email, etc).
  try {
    const envDevPath = path.resolve(process.cwd(), '.env.dev');
    if (fs.existsSync(envDevPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envDevPath));
      if (!process.env.REDX_API_KEY && parsed.REDX_API_KEY) process.env.REDX_API_KEY = parsed.REDX_API_KEY;
      if (!process.env.REDX_API_URL && parsed.REDX_API_URL) process.env.REDX_API_URL = parsed.REDX_API_URL;
    }
  } catch {
    // Best-effort; tests can still run without RedX integration credentials.
  }

  // Ensure common env vars exist before app/config modules are imported in tests
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-123456789';
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-key-1234567890123456';

  // Start MongoDB Memory Server
  mongoServer = await MongoMemoryServer.create({
    instance: {
      dbName: 'test-bigboss',
    },
  });

  const uri = mongoServer.getUri();
  process.env.MONGO_URI = uri;

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
