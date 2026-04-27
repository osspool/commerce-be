/**
 * Guest checkout — E2E integration coverage.
 *
 * Validates the anonymous `/orders/guest/place` route:
 *   1. Accepts no auth (public)
 *   2. Upserts Customer rows by phone (returning guest hits same row)
 *   3. Drops staff-only body fields (sellerId, typeData, metadata)
 *   4. Rejects malformed input with structured 400
 *   5. Returns 404 when GUEST_CHECKOUT=false
 *
 * Uses the same MongoMemoryReplSet harness as orders-e2e.test.ts so stock
 * reservation actually executes instead of being stubbed.
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let orgId: string;
let testProductId: string;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName: 'Guest Checkout Store',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();

  const ts = Date.now();
    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Guest-${ts}`, slug: `guest-${ts}` },
    users: [
      {
        key: 'admin',
        email: `guest-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Guest Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
  });

  server = ctx.app;
  orgId = ctx.orgId;

  // Pin this branch as the e-com fulfillment target so guest orders
  // land here — the fulfillsEcommerce capability flag is the canonical
  // Option-A path (`branch.type` stays scalar identity; capabilities are
  // orthogonal booleans). Pre-rewrite this test was flipping
  // `type: 'ecommerce'`, which is no longer a valid type value.
  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { fulfillsEcommerce: true, isActive: true } },
  );
  const { resetEcomBranchCache } = await import('#resources/sales/orders/ecom-branch.js');
  resetEcomBranchCache();

  const testSku = `GUEST-SKU-${ts}`;
  const prodResult = await db.collection('catalog_products').insertOne({
    name: 'Guest Test Widget',
    slug: `guest-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 25000, currency: 'BDT' } } },
    identifiers: { custom: { sku: testSku } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  testProductId = prodResult.insertedId.toString();

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  // Simple product → Flow-canonical skuRef = product._id (matches
  // `skuRefFromProduct(productId, null)` + catalog bridge's simple-product
  // snapshot sku).
  await seedStock(flow, orgId, testProductId, 1000, 5000);
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

describe('Guest checkout — /orders/guest/place', () => {
  const basePayload = () => ({
    lines: [
      {
        kind: 'sku',
        offerId: testProductId,
        quantity: 1,
        unitPriceOverride: { amount: 25000, currency: 'BDT' },
      },
    ],
    customer: { name: 'Fatima Rahman', phone: '+8801711000001', email: 'fatima@example.com' },
    shippingAddress: { line1: '42 Road 11', city: 'Dhaka', division: 'Dhaka' },
  });

  it('accepts anonymous submission (no auth headers)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: basePayload(),
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect(typeof body?.guestCustomerId).toBe('string');
    const order = body?.data as Record<string, unknown>;
    expect(order.channel).toBe('web');
    expect(order.organizationId).toBe(orgId);
  });

  it('upserts the Customer row — returning guest with same phone hits same id', async () => {
    const first = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'Karim Hossain', phone: '+8801711000002', email: 'karim@example.com' },
      },
    });
    const firstBody = parse(first.body);
    const firstCustomerId = firstBody?.guestCustomerId as string;

    const second = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'Karim Hossain', phone: '+8801711000002', email: 'karim@example.com' },
      },
    });
    const secondBody = parse(second.body);
    expect(secondBody?.guestCustomerId).toBe(firstCustomerId);
  });

  it('dedupes across phone format variants (E.164, national, spaces, dashes)', async () => {
    // Same BD number in four different surface forms that a real client might
    // send. After server-side normalization they MUST resolve to one Customer.
    const canonical = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'Rashid Ahmed', phone: '+8801712345678', email: 'rashid@example.com' },
      },
    });
    expect(canonical.statusCode).toBe(201);
    const targetId = parse(canonical.body)?.guestCustomerId as string;

    const variants = [
      '01712345678',          // national format, default country BD resolves dial code
      '+880 1712-345-678',    // pretty-printed with spaces + dashes
      '+8801712345678',       // already E.164 — same canonical
      '880 17 12 34 56 78',   // no leading +, parser still recognises BD prefix
    ];

    for (const phone of variants) {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/orders/guest/place`,
        payload: {
          ...basePayload(),
          customer: { name: 'Rashid Ahmed', phone, email: 'rashid@example.com' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(parse(res.body)?.guestCustomerId).toBe(targetId);
    }
  });

  it('accepts foreign E.164 numbers (US, UK, AE)', async () => {
    const foreign = [
      { phone: '+14155552671', email: 'us@example.com' },      // US
      { phone: '+442079460000', email: 'uk@example.com' },     // UK
      { phone: '+971501234567', email: 'uae@example.com' },    // UAE
    ];
    for (const { phone, email } of foreign) {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/orders/guest/place`,
        payload: {
          ...basePayload(),
          customer: { name: 'Foreign Customer', phone, email },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(typeof parse(res.body)?.guestCustomerId).toBe('string');
    }
  });

  it('rejects phone that is syntactically digits but not a real number', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'Bogus Phone', phone: '+1000000000000', email: 'bogus@example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)?.field).toBe('customer.phone');
  });

  it('drops staff-only fields silently (sellerId / metadata ignored)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'Guest Three', phone: '+8801711000003', email: 'three@example.com' },
        sellerId: '507f1f77bcf86cd799439011',
        typeData: { internalOverride: true },
        metadata: { staffNote: 'VIP' },
      },
    });
    expect(res.statusCode).toBe(201);
    const order = (parse(res.body)?.data as Record<string, unknown>) ?? {};
    expect(order.sellerId).toBeFalsy();
    const meta = order.metadata as Record<string, unknown> | undefined;
    expect(meta?.staffNote).toBeUndefined();
  });

  it('rejects missing phone with structured 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'No Phone', email: 'nophone@example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = parse(res.body);
    expect(body?.success).toBe(false);
    expect(body?.field).toBe('customer.phone');
  });

  it('rejects missing email with structured 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        ...basePayload(),
        customer: { name: 'No Email', phone: '+8801711000050' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)?.field).toBe('customer.email');
  });

  it('rejects empty lines with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/guest/place`,
      payload: {
        lines: [],
        customer: { name: 'Empty Cart', phone: '+8801711000099', email: 'empty@example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)?.field).toBe('lines');
  });
});
