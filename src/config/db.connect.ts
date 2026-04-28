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

// ─── Module-load setup — runs the FIRST time anything imports this file ──
//
// `mongoose.set('bufferTimeoutMS', ...)` MUST run before any model is
// registered. Model registration happens at module-evaluation time of
// every `*.engine.ts` file (accounting, POS, order, revenue, …) which
// transitively load via `app.ts`'s static imports. If we set the timeout
// inside `connectDatabase()`, it's too late — the buffered ops were
// already queued with the default 10s timer and crash before we get a
// chance to bump it.
//
// Same logic for the connection-lifecycle listeners: attach them once,
// at module load, so every connect attempt and every reconnect surfaces
// in the logs.
mongoose.set('strictQuery', true);
mongoose.set('bufferTimeoutMS', 30000);

mongoose.connection.on('connecting', () => console.log('[db] connecting...'));
mongoose.connection.on('connected', () =>
  console.log(`[db] connected (readyState: ${mongoose.connection.readyState})`),
);
mongoose.connection.on('error', (err: Error) => console.error(`[db] error: ${err.message}`));
mongoose.connection.on('disconnected', () => console.log('[db] disconnected'));
mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));

let _connecting: Promise<typeof mongoose> | null = null;

/** Pull the host:port (or SRV host) out of a Mongo URI for safe logging. */
function safeHost(uri: string): string {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, 'https://').replace(/^mongodb:\/\//, 'http://'));
    return u.host || '(unknown)';
  } catch {
    return '(unparsable)';
  }
}

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

  // `strictQuery`, `bufferTimeoutMS`, and the lifecycle listeners are
  // all set at MODULE-LOAD time above (see the "Module-load setup"
  // block). Setting them here would be too late — model registrations
  // in eager-loaded engine files would already have queued ops with
  // the default 10s timeout.
  log(`before connect, readyState: ${mongoose.connection.readyState}, uri host: ${safeHost(uri)}`);

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
        log(`after connect, readyState: ${mongoose.connection.readyState}`);
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
