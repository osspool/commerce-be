/**
 * Per-suite MongoDB setup — each vitest config gets its own MongoMemoryServer.
 *
 * Replaces the old global-setup.js + .mongo-test-state.json pattern that
 * forced all configs into a single shared MongoDB and prevented concurrent
 * suite execution.
 *
 * How it works:
 *   1. vitest.*.config.ts uses this as `setupFiles` (runs once per worker)
 *   2. First call spins up a MongoMemoryServer and connects mongoose
 *   3. process.env.MONGO_URI is set so app code picks it up
 *   4. afterAll (vitest hook) tears down cleanly
 *
 * This means `npm run test:fast`, `npm run test:db:app`, `npm run test:integration`
 * can all run as separate processes in parallel — each has its own MongoDB.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll } from 'vitest';

let server: MongoMemoryServer | null = null;

// Ensure common env vars exist before app/config modules are imported.
// Secrets must be >=32 chars to satisfy validateEnvironmentOrThrow (security
// rule in src/config/validator.ts), which now runs at createApplication().
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-32-characters';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-key-1234567890123456';
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-at-least-32-chars-long';
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || 'http://localhost:0';
process.env.NODE_ENV = 'test';

// Only start a server + connect if nothing is connected yet.
// Tests that manage their own MongoMemoryServer (e.g. event-integration-e2e)
// will already have connected by the time vitest runs setupFiles.
if (mongoose.connection.readyState === 0 && !process.env.MONGO_URI) {
  server = await MongoMemoryServer.create({
    instance: { dbName: `test-${process.pid}` },
  });
  const uri = server.getUri();
  process.env.MONGO_URI = uri;
  globalThis.__MONGO_URI__ = uri;
  globalThis.__MONGO_SERVER__ = server;
  await mongoose.connect(uri);
} else if (mongoose.connection.readyState === 0 && process.env.MONGO_URI) {
  await mongoose.connect(process.env.MONGO_URI);
}

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (server) {
    await server.stop();
    server = null;
  }
});
