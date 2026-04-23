/**
 * Connection Registry Barrel
 *
 * Single import surface for every external database connection this app
 * opens. Everywhere else in the codebase should call
 * `getMongoConnection('primary')` instead of reaching for the
 * `mongoose.connection` global directly — keeps connection-role intent
 * explicit and makes the app's external-dependency topology greppable
 * from one file.
 *
 * Redis is intentionally NOT in this registry yet — the app doesn't
 * consume Redis anywhere today. When a workload lands (sessions, cache,
 * rate-limit, BullMQ, event pub/sub), add a `redis.ts` sibling exporting
 * `getRedis(role)` with one `ioredis` client per workload. See arc's
 * docs for why workloads shouldn't share a pool.
 *
 * Lifecycle helpers:
 *   - `connectAllEssentials()` — resolve the connections that must be
 *     open before Arc resource discovery runs. Called from `app.ts`.
 *   - `disconnectAll()` — wired into Fastify's `onClose` hook so rolling
 *     deploys tear down every connection deterministically.
 */

import { disconnectAllMongo, getMongoConnection, type MongoRole } from './mongo.js';

export { disconnectAllMongo, getMongoConnection, type MongoRole };

/**
 * Open every connection that must be ready BEFORE Arc boots (i.e. before
 * resource files load their models). Today that's just the primary mongo.
 */
export async function connectAllEssentials(): Promise<void> {
  await getMongoConnection('primary');
}

/**
 * Tear down every connection this registry opened. Safe to call repeatedly.
 */
export async function disconnectAll(): Promise<void> {
  await Promise.allSettled([disconnectAllMongo()]);
}
