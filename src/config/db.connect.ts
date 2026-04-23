/**
 * Standalone Mongoose Connection
 *
 * Connects mongoose to MongoDB. Idempotent — returns immediately if already
 * connected (e.g. by tests via setup hook). Used by app.ts to ensure the DB
 * is ready BEFORE Arc resource discovery runs, so engine-owned models are
 * available when resource files are imported.
 */

import mongoose from 'mongoose';
import config from './index.js';

interface ConnectOptions {
  /** Override URI (e.g. for tests). Falls back to globalThis.__MONGO_URI__ → process.env.MONGO_URI → config.db.uri */
  uri?: string;
  /** Logger function — defaults to console.log */
  log?: (msg: string) => void;
}

let _connecting: Promise<typeof mongoose> | null = null;

/**
 * Connect mongoose to the configured database.
 *
 * - Idempotent: returns immediately if already connected
 * - Concurrency-safe: parallel calls share a single in-flight connection
 * - Test-aware: reads `globalThis.__MONGO_URI__` if set
 */
export async function connectDatabase(options: ConnectOptions = {}): Promise<typeof mongoose> {
  // Already connected — reuse
  if (mongoose.connection.readyState === 1) return mongoose;

  // Connection in progress — share the promise
  if (_connecting) return _connecting;

  const log = options.log ?? ((msg: string) => console.log(`[db] ${msg}`));

  // Resolve URI: explicit option > test global > env > config
  const testUri =
    typeof globalThis !== 'undefined'
      ? (globalThis as typeof globalThis & { __MONGO_URI__?: string }).__MONGO_URI__
      : undefined;

  const uri = options.uri || testUri || process.env.MONGO_URI || config.db?.uri;

  if (!uri) {
    throw new Error('connectDatabase: MONGO_URI is not defined in configuration');
  }

  const maxRetries = process.env.DB_CONNECT_MAX_RETRIES ? Number(process.env.DB_CONNECT_MAX_RETRIES) : 5;
  const baseDelayMs = process.env.DB_CONNECT_RETRY_MS ? Number(process.env.DB_CONNECT_RETRY_MS) : 2000;
  const backoff = process.env.DB_CONNECT_BACKOFF ? Number(process.env.DB_CONNECT_BACKOFF) : 1.5;

  mongoose.set('strictQuery', true);

  _connecting = (async () => {
    let attempt = 0;
    let delayMs = baseDelayMs;

    while (attempt < maxRetries) {
      attempt++;
      try {
        log('Connecting to database');
        await mongoose.connect(uri, {
          serverSelectionTimeoutMS: 10000,
          socketTimeoutMS: 45000,
          maxPoolSize: 20,
        });
        log('Database connected');
        return mongoose;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`Database connection failed (attempt ${attempt}/${maxRetries}): ${errMsg}`);
        if (attempt >= maxRetries) {
          _connecting = null;
          throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${errMsg}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoff, 60000);
      }
    }

    _connecting = null;
    throw new Error('Unreachable');
  })();

  try {
    return await _connecting;
  } finally {
    _connecting = null;
  }
}
