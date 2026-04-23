/**
 * POS delivery → Fulfillment — opt-in delivery creates a shippable record.
 *
 * The default POS flow is walk-in-first: customer pays at the counter,
 * takes the goods, and the order has no fulfillment/address. Stock
 * decrement happens at create time via `wireOrderStockHook`.
 *
 * But some in-store customers want delivery ("ship it to my house").
 * For those, POS must persist the address on a Fulfillment record so the
 * logistics module can dispatch it later. Without this, a POS delivery
 * order is a dead end — paid but un-shippable.
 *
 * This test proves three behaviors, because all three are failure modes:
 *
 *   1. `deliveryMethod: 'delivery'` + `deliveryAddress` → 1 Fulfillment,
 *      address matches. Logistics can pick up from here.
 *   2. `deliveryMethod: 'pickup'` (default) → 0 Fulfillments. We don't
 *      want to create parcel records for every walk-in sale.
 *   3. `deliveryMethod: 'delivery'` WITHOUT address → 0 Fulfillments
 *      (graceful skip + warning log). The order still commits; admin can
 *      add the address + create fulfillment manually.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/pos-delivery-fulfillment-e2e.test.ts
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.FLOW_VALUATION_METHOD = 'fifo';
process.env.ENABLE_ACCOUNTING = 'true';
process.env.ACCOUNTING_MODE = 'standard';
process.env.ACCOUNTING_AUTO_SEED = 'true';
process.env.ACCOUNTING_AUTO_POST = 'true';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  type AuthProvider,
  createBetterAuthProvider,
  setupBetterAuthOrg,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: AuthProvider;
let orgId: string;
let productId: string;
const POS_PRICE = 25000; // 250 BDT in paisa... wait — POS body uses major units. See below.
// POS controller treats `price` as major units and multiplies to paisa (pos.controller.ts:180).
const POS_UNIT_PRICE_MAJOR = 250;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface PlacePosOrderInput {
  deliveryMethod?: 'pickup' | 'delivery';
  deliveryAddress?: Record<string, unknown>;
  quantity?: number;
}

async function placePosOrder(
  input: PlacePosOrderInput = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const quantity = input.quantity ?? 1;
  const res = await server.inject({
    method: 'POST',
    url: `${API}/pos/orders`,
    headers: auth.getHeaders('admin'),
    payload: {
      items: [{ productId, quantity, price: POS_UNIT_PRICE_MAJOR }],
      payments: [{ method: 'cash', amount: POS_UNIT_PRICE_MAJOR * quantity }],
      ...(input.deliveryMethod ? { deliveryMethod: input.deliveryMethod } : {}),
      ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
      idempotencyKey: `pos-${Date.now()}-${Math.random()}`,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function getFulfillmentsForOrder(orderNumber: string): Promise<Record<string, unknown>[]> {
  // Canonical collection name per @classytic/order — fulfillment.model.ts
  // registers the model as `OrderFulfillment` with collection `order_fulfillments`.
  // Not `fulfillments` (which is mongoose's default pluralization).
  return mongoose.connection.db!
    .collection('order_fulfillments')
    .find({ orderNumber })
    .toArray() as Promise<Record<string, unknown>[]>;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true,
    storeName: 'POS Delivery E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
  });

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `pos-delivery-admin-${ts}@test.com`;

  const ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: resources as never }),
    org: { name: `POS-Delivery-${ts}`, slug: `pos-d-${ts}` },
    users: [
      {
        key: 'admin',
        email: adminEmail,
        password: 'TestPass123!',
        name: 'POS Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const r = await getAuth().api.addMember({ body: data });
      return { statusCode: r ? 200 : 500 };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;
  await db.collection('user').updateOne({ email: adminEmail }, { $set: { role: ['admin'] } });

  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ tokens: { admin: token }, orgId, adminRole: 'admin' });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'POS-D-HO', isDefault: true, isActive: true } },
  );

  // Seed product with stock. POS channel must be able to decrement at
  // create-time via wireOrderStockHook — all the more important to have
  // real stock on hand; otherwise the pre-check at pos.controller:157
  // fails before we get to the fulfillment step we're testing.
  const sku = `POS-D-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'POS Delivery Widget',
    slug: `pos-delivery-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: POS_PRICE, currency: 'BDT' } } },
    identifiers: { custom: { sku } },
    createdAt: new Date(),
  });
  productId = prod.insertedId.toString();

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../helpers/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  await seedStock(flow, orgId, productId, 1000, 10000);

  // POS orders require an open shift (pos.controller rejects otherwise).
  const shiftRes = await server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: auth.getHeaders('admin'),
    payload: { openingCash: 0 },
  });
  if (shiftRes.statusCode !== 201) {
    throw new Error(`Shift open failed: ${shiftRes.statusCode} ${shiftRes.body}`);
  }

  const { accountRepository } = await import('#resources/accounting/accounting.engine.js');
  await accountRepository.seedAccounts(undefined);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('POS delivery → fulfillment wiring', () => {
  it('walk-in pickup (default) creates NO fulfillment — just a goods-leave-on-sale order', async () => {
    const res = await placePosOrder({}); // no deliveryMethod → default 'pickup'
    expect(res.status).toBe(201);
    const order = res.body?.data as { orderNumber: string; _id: string };

    const fulfillments = await getFulfillmentsForOrder(order.orderNumber);
    expect(fulfillments.length, 'pickup orders must not create fulfillments').toBe(0);
  });

  it('POS order with deliveryMethod=delivery + address creates a fulfillment with the shippingAddress', async () => {
    const deliveryAddress = {
      recipientName: 'In-Store Buyer',
      recipientPhone: '01711112222',
      addressLine1: 'House 10, Road 5',
      areaId: 1,
      areaName: 'Dhanmondi',
      zoneId: 1,
      city: 'Dhaka',
      division: 'Dhaka',
      country: 'Bangladesh',
    };

    const res = await placePosOrder({ deliveryMethod: 'delivery', deliveryAddress });
    expect(res.status).toBe(201);
    const order = res.body?.data as { orderNumber: string; _id: string };

    const fulfillments = await getFulfillmentsForOrder(order.orderNumber);
    expect(fulfillments.length, 'delivery POS orders must create a fulfillment').toBe(1);

    const f = fulfillments[0]!;
    expect(f.orderNumber).toBe(order.orderNumber);
    // The fulfillment schema uses the CANONICAL address shape
    // `{ name, line1, city, country, phone, ... }`. `toFulfillmentAddress`
    // maps recipientName→name, addressLine1→line1, recipientPhone→phone,
    // division→state. That's why we assert on the canonical names here,
    // not the FE shape we sent above.
    const addr = f.shippingAddress as Record<string, unknown>;
    expect(addr).toBeTruthy();
    expect(addr.name).toBe(deliveryAddress.recipientName);
    expect(addr.phone).toBe(deliveryAddress.recipientPhone);
    expect(addr.line1).toBe(deliveryAddress.addressLine1);
    expect(addr.city).toBe('Dhaka');
    expect(addr.country).toBe('Bangladesh');
    expect(addr.state).toBe('Dhaka'); // division → state mapping
    // BD routing fields round-trip verbatim (@classytic/order v post-2026-04
    // schema extension). These let logistics adapters / Pathao export skip
    // name-matching and use authoritative ids. zoneId: 1 + areaId: 1 are
    // what the FE sent; they must survive Mongoose strict on save.
    expect(addr.areaId).toBe(1);
    expect(addr.zoneId).toBe(1);
    expect(addr.areaName).toBe('Dhanmondi');
  });

  it('provider-specific refs (pathao.cityId/zoneId) round-trip via the Mixed providerRefs bag', async () => {
    // The Pathao CSV exporter reads providerRefs.pathao.{cityId,zoneId} to
    // skip name-matching. This test proves the schema preserves the bag
    // verbatim end-to-end. If the @classytic/order schema ever reverts to
    // strict on addressSchema (dropping Mixed providerRefs), this fails
    // before any carrier integration silently loses routing.
    const deliveryAddress = {
      recipientName: 'Pathao Buyer',
      recipientPhone: '01722223333',
      addressLine1: 'Road 12, House 7',
      city: 'Dhaka',
      country: 'Bangladesh',
      providerAreaIds: {
        pathao: { cityId: 1, zoneId: 298, areaId: 8612 },
        redx: { areaId: 1234 },
      },
    };

    const res = await placePosOrder({ deliveryMethod: 'delivery', deliveryAddress });
    expect(res.status).toBe(201);
    const order = res.body?.data as { orderNumber: string };

    const fulfillments = await getFulfillmentsForOrder(order.orderNumber);
    expect(fulfillments.length).toBe(1);
    const addr = (fulfillments[0]!.shippingAddress as Record<string, unknown>) ?? {};
    const refs = addr.providerRefs as Record<string, Record<string, number>>;
    expect(refs?.pathao?.cityId).toBe(1);
    expect(refs?.pathao?.zoneId).toBe(298);
    expect(refs?.pathao?.areaId).toBe(8612);
    expect(refs?.redx?.areaId).toBe(1234);
  });

  it('deliveryMethod=delivery without an address commits the order but skips the fulfillment', async () => {
    // Graceful degrade: the sale still completes (payment captured, stock
    // decremented by the POS hook), but logistics has nothing to dispatch.
    // Admin sees the order and can create a fulfillment manually from the
    // order detail page. No crash, no 500.
    const res = await placePosOrder({ deliveryMethod: 'delivery' }); // no address
    expect(res.status).toBe(201);
    const order = res.body?.data as { orderNumber: string; _id: string };

    const fulfillments = await getFulfillmentsForOrder(order.orderNumber);
    expect(fulfillments.length).toBe(0);
  });
});
