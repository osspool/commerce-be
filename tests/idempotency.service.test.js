import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { idempotencyService } from '#modules/commerce/core/index.js';

describe('IdempotencyService (Mongo-backed)', () => {
  let shouldDisconnect = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI);
      shouldDisconnect = true;
    }
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  it('creates pending record and returns cached result after completion', async () => {
    const key = `test_key_${Date.now()}`;
    const payload = { source: 'test', items: [{ productId: 'p1', quantity: 1 }] };

    const first = await idempotencyService.check(key, payload);
    expect(first.isNew).toBe(true);

    await idempotencyService.complete(key, { orderId: 'o1', ok: true });

    const second = await idempotencyService.check(key, payload);
    expect(second.isNew).toBe(false);
    expect(second.existingResult).toEqual({ orderId: 'o1', ok: true });
  });

  it('blocks concurrent duplicates while pending', async () => {
    const key = `test_pending_${Date.now()}`;
    const payload = { source: 'test', items: [{ productId: 'p1', quantity: 1 }] };

    const first = await idempotencyService.check(key, payload);
    expect(first.isNew).toBe(true);

    await expect(idempotencyService.check(key, payload)).rejects.toMatchObject({
      code: 'REQUEST_IN_PROGRESS',
      statusCode: 409,
    });
  });

  it('rejects same key with different payload', async () => {
    const key = `test_mismatch_${Date.now()}`;
    const payloadA = { source: 'test', items: [{ productId: 'p1', quantity: 1 }] };
    const payloadB = { source: 'test', items: [{ productId: 'p2', quantity: 1 }] };

    const first = await idempotencyService.check(key, payloadA);
    expect(first.isNew).toBe(true);

    await expect(idempotencyService.check(key, payloadB)).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      statusCode: 409,
    });
  });
});
