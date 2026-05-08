// src/config/sections/db.config.ts

export interface DbSectionConfig {
  db: {
    uri: string;
    /** Max sockets per Node process. Driver default is 100; we cap at 50 by default to leave Atlas headroom across multiple app instances + cron. */
    maxPoolSize: number;
    /** Warm sockets kept open while idle — first request after quiet period skips handshake latency. */
    minPoolSize: number;
    /**
     * How long a request waits for a free socket before failing fast (ms).
     * Surfaces saturation as a clear error instead of silent backpressure.
     *
     * Default 30s (was 5s) so cold-boot index materialization storms don't
     * cascade into `WaitQueueTimeoutError` at `Collection.createIndex`. If
     * legitimate steady-state checkouts ever exceed 30s, that's a load
     * issue (raise `MONGO_MAX_POOL_SIZE`) — not a timing one.
     */
    waitQueueTimeoutMS: number;
    /** Initial server-selection budget on cold connect (ms). */
    serverSelectionTimeoutMS: number;
    /** Idle socket lifetime (ms). */
    socketTimeoutMS: number;
    validate: () => boolean;
  };
}

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const dbConfig: DbSectionConfig = {
  db: {
    uri: process.env.MONGO_URI || '',
    maxPoolSize: num('MONGO_MAX_POOL_SIZE', 50),
    minPoolSize: num('MONGO_MIN_POOL_SIZE', 5),
    waitQueueTimeoutMS: num('MONGO_WAIT_QUEUE_TIMEOUT_MS', 30000),
    serverSelectionTimeoutMS: num('MONGO_SERVER_SELECTION_TIMEOUT_MS', 10000),
    socketTimeoutMS: num('MONGO_SOCKET_TIMEOUT_MS', 45000),

    validate(): boolean {
      if (!this.uri) {
        throw new Error('MONGO_URI is not defined in environment variables');
      }
      return true;
    },
  },
};

export default dbConfig;
