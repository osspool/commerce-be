/**
 * MongoDB Connection Registry
 *
 * Named mongoose connections per bounded context. Today we have a single
 * primary database, but this registry exists so that when we grow into
 * analytics, identity, or archive databases, every connection lives in one
 * file and every call site is typed — not reaching for `mongoose.connection`
 * as an implicit global.
 *
 * Arc plugins no longer accept raw connections — pass a mongokit
 * `Repository` built from a model on this connection instead:
 *
 * ```ts
 * import { Repository } from '@classytic/mongokit';
 * const conn = await getMongoConnection('primary');
 * const repo = new Repository(conn.model('AuditEntry', schema));
 * await fastify.register(auditPlugin, { repository: repo });
 * ```
 *
 * When adding a new bounded-context database:
 *   1. Add the role to `MongoRole` below.
 *   2. Add the URI lookup in `URI_MAP`.
 *   3. Optionally tune connection options in `POOL_MAP`.
 *   4. Call `getMongoConnection('<role>')` at the wire-up site.
 */

import mongoose, { type Connection, type ConnectOptions } from 'mongoose';
import { connectDatabase } from '../db.connect.js';

/**
 * Named bounded-context databases. Extend with `'analytics'`, `'archive'`,
 * etc. when new databases come online — and grow the switch in
 * `getMongoConnection` by one arm.
 */
export type MongoRole = 'primary';

/**
 * In-flight connection promises keyed by role. Concurrency-safe: parallel
 * callers for the same role share a single connection attempt.
 */
const connections: Partial<Record<MongoRole, Promise<Connection>>> = {};

// Reserved for future role configuration (URI + pool tuning) once the first
// non-primary role is added. Kept as a single exported const so additions
// are obvious and greppable.
const DEFAULT_POOL: ConnectOptions = {
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  maxPoolSize: 20,
};

/**
 * Resolve (and create if needed) the mongoose Connection for a given role.
 * Idempotent — repeat calls return the cached connection.
 *
 * `primary` delegates to `connectDatabase()` to preserve the existing retry
 * / backoff / test-URI behaviour. Future roles will `createConnection()`
 * directly.
 */
export function getMongoConnection(role: MongoRole = 'primary'): Promise<Connection> {
  const cached = connections[role];
  if (cached) return cached;

  const pending = (async (): Promise<Connection> => {
    // Today we only have primary — once more roles are added, switch here
    // on `role` and call `mongoose.createConnection(uri, DEFAULT_POOL)`.
    await connectDatabase();
    return mongoose.connection;
  })();

  connections[role] = pending;
  pending.catch(() => {
    delete connections[role];
  });
  return pending;
}

// Keep `DEFAULT_POOL` referenced even when only primary exists, so a future
// role addition doesn't trigger a "newly used" import noise diff.
void DEFAULT_POOL;

/**
 * Close every mongoose connection this registry opened. Primary is closed
 * via `mongoose.disconnect()` (respects the existing global connection);
 * named connections are closed individually.
 */
export async function disconnectAllMongo(): Promise<void> {
  const roles = Object.keys(connections) as MongoRole[];
  await Promise.allSettled(
    roles.map(async (role) => {
      const conn = await connections[role];
      delete connections[role];
      if (role === 'primary') {
        await mongoose.disconnect();
      } else {
        await conn?.close();
      }
    }),
  );
}
