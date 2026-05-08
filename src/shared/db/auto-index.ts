/**
 * Mongoose autoIndex policy — single source of truth.
 *
 * ## Why this is centralised
 *
 * Mongoose's `autoIndex: true` makes every model fire `Collection.createIndex`
 * on connection. be-prod boots **9 separate engines** (revenue, transfer,
 * purchase, order, loyalty, pos, cart, promo, catalog) each registering N
 * models — that's dozens of parallel `createIndex` ops the moment the pool
 * comes up. On cold boots against Atlas (especially shared M0/M2 tiers, or
 * after a sleep/wake cycle) these saturate the connection pool's wait queue
 * faster than `waitQueueTimeoutMS` can clear it, and boot fails with:
 *
 *   STARTUP ERROR: WaitQueueTimeoutError ... at Collection.createIndex
 *
 * The fix is to **opt out of autoIndex by default** — indexes already exist
 * on the dev DB; recreating them every boot adds zero value and burns the
 * pool. When you genuinely add a new index (schema change, new model), set
 * `MONGOOSE_AUTO_INDEX=true` once, boot, watch the index get created, then
 * unset and continue developing.
 *
 * ## Defaults
 *
 * | NODE_ENV | MONGOOSE_AUTO_INDEX | Result |
 * |---|---|---|
 * | (any)    | `true`              | autoIndex ON  — explicit opt-in |
 * | (any)    | `false` / `0` / `no`| autoIndex OFF — explicit opt-out |
 * | `production` | unset            | autoIndex OFF (matches prior behavior) |
 * | `test`   | unset                | autoIndex ON (MongoMemoryServer is fresh per test, no real cost) |
 * | `development` | unset           | autoIndex OFF (the fix — was previously ON, caused boot storms) |
 *
 * ## When to flip MONGOOSE_AUTO_INDEX=true
 *
 * - You added a new `index: true` / `unique: true` / `@Index` to a schema
 * - You see a query going slow and suspect a missing index — add it, set the
 *   flag for one boot, observe `db.collection.getIndexes()` confirms it landed,
 *   unset the flag.
 * - You wiped a dev DB and need indexes on the empty collections.
 *
 * For production deploys, run `Model.syncIndexes()` once in a migration step
 * (or the engine's own bootstrap helper) — never enable autoIndex on a
 * production process serving traffic, because mongoose serialises all
 * createIndex calls behind the connection and any locked index migration
 * stalls every other op.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off']);

/**
 * Should be passed to every engine's `autoIndex:` option. Returns a single
 * boolean, evaluated lazily so tests can mutate `process.env` before the
 * first call.
 */
export function shouldAutoIndex(): boolean {
  const raw = process.env.MONGOOSE_AUTO_INDEX?.toLowerCase().trim();

  // Explicit opt-in / opt-out wins regardless of NODE_ENV.
  if (raw && TRUTHY.has(raw)) return true;
  if (raw && FALSY.has(raw)) return false;

  // Defaults by environment.
  if (process.env.NODE_ENV === 'test') return true;
  return false;
}
