import { idempotencyPlugin } from '@classytic/arc/idempotency';
import { Repository, batchOperationsPlugin, methodRegistryPlugin } from '@classytic/mongokit';
import Fastify from 'fastify';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const COLLECTION = 'arc_idempotency_e2e';

// Arc 2.9.1 dropped the standalone `MongoIdempotencyStore` class. The plugin
// now accepts a `RepositoryLike` directly and wraps it via an inline
// `repositoryAsIdempotencyStore` adapter. We expose a minimal mongoose model +
// mongokit Repository here — the TTL index stays on the schema (same TTL
// semantics the old store provided), the doc shape matches what arc's adapter
// writes (`_id`, `result`, `lock`, `createdAt`, `expiresAt`).
const idempotencySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    result: {
      statusCode: Number,
      headers: mongoose.Schema.Types.Mixed,
      body: mongoose.Schema.Types.Mixed,
    },
    lock: {
      requestId: String,
      expiresAt: Date,
    },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { _id: false, collection: COLLECTION },
);

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 250): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Arc MongoDB Idempotency', () => {
  let app: ReturnType<typeof Fastify>;
  let hitCount = 0;

  beforeAll(async () => {
    await mongoose.connection.db.admin().command({
      setParameter: 1,
      ttlMonitorSleepSecs: 1,
    });

    await mongoose.connection.db.collection(COLLECTION).deleteMany({});

    const IdempotencyModel =
      mongoose.connection.models.ArcIdempotencyE2E ??
      mongoose.connection.model('ArcIdempotencyE2E', idempotencySchema);
    // Ensure TTL index exists on `expiresAt` (mongo auto-cleans expired docs).
    await IdempotencyModel.syncIndexes();
    // `batchOperationsPlugin` exposes `deleteMany` on the Repository —
    // arc's idempotency plugin requires it (see `repositoryAsIdempotencyStore`).
    // `methodRegistryPlugin` is a batch-operations prerequisite.
    const repository = new Repository(IdempotencyModel as any, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]);

    app = Fastify();

    await app.register(idempotencyPlugin, {
      enabled: true,
      headerName: 'idempotency-key',
      ttlMs: 1_500,
      methods: ['POST'],
      repository: repository as any,
    });

    app.post(
      '/idempotent-checkout',
      {
        preHandler: [app.idempotency.middleware],
      },
      async (request) => {
        hitCount += 1;
        return {
          success: true,
          payload: request.body,
          hitCount,
        };
      },
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await mongoose.connection.db.collection(COLLECTION).deleteMany({});
  });

  it('replays the cached response from MongoDB for the same key and payload', async () => {
    const payload = { amount: 100, items: [{ sku: 'sku-1', qty: 1 }] };

    const first = await app.inject({
      method: 'POST',
      url: '/idempotent-checkout',
      headers: { 'idempotency-key': 'checkout-1' },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-idempotency-key']).toBe('checkout-1');
    expect(JSON.parse(first.body)).toMatchObject({
      success: true,
      hitCount: 1,
    });

    const second = await app.inject({
      method: 'POST',
      url: '/idempotent-checkout',
      headers: { 'idempotency-key': 'checkout-1' },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-idempotency-key']).toBe('checkout-1');
    expect(second.headers['x-idempotency-replayed']).toBe('true');
    expect(JSON.parse(second.body)).toMatchObject({
      success: true,
      hitCount: 1,
    });

    expect(hitCount).toBe(1);

    const stored = await mongoose.connection.db.collection(COLLECTION).findOne({
      _id: { $regex: '^checkout-1:' },
    });
    expect(stored).toBeTruthy();
    expect(stored?.result?.statusCode).toBe(200);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
  });

  it('creates a TTL index and lets MongoDB auto-clean expired idempotency entries', async () => {
    const indexes = await mongoose.connection.db.collection(COLLECTION).indexes();
    expect(indexes.some((index) => index.key?.expiresAt === 1 && index.expireAfterSeconds === 0)).toBe(true);

    const payload = { amount: 200, items: [{ sku: 'sku-2', qty: 2 }] };

    const response = await app.inject({
      method: 'POST',
      url: '/idempotent-checkout',
      headers: { 'idempotency-key': 'checkout-ttl' },
      payload,
    });
    expect(response.statusCode).toBe(200);

    await waitFor(async () => {
      const count = await mongoose.connection.db.collection(COLLECTION).countDocuments({
        _id: { $regex: '^checkout-ttl:' },
      });
      return count === 0;
    });
  });
});
