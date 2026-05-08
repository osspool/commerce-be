/**
 * Fulfillment workflow & permissions — single-tenant multi-branch commerce.
 *
 * Pins the admin / branch_manager / unauth matrix for
 * `POST /fulfillments/:id/action` transitions (pick → pack → ship → deliver)
 * with strong assertions on the resulting `fulfillment.status`.
 *
 * Business rule: store staff own delivery status for their own branch — a
 * branch manager must be able to mark an order delivered without escalating
 * to head office. Platform admin can also do it (ops override).
 *
 * What this test adds that the existing fulfillment e2e (24 tests) doesn't:
 *   1. status after each transition is asserted (`shipped`, `delivered`) —
 *      not just `statusCode !== 404`.
 *   2. branch_manager role can transition — pins the permission widening.
 *   3. Unauthenticated call is rejected with 401.
 *   4. Non-member of the branch cannot transition (403).
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let server: FastifyInstance;
let adminAuth: TestAuthProvider;
let orgId: string;

let branchManagerToken: string;
let outsiderToken: string;
let orderNumber: string;
let fulfillmentNumber: string;
let productSku: string;
let productId: string;

const adminHeaders = () => ({ ...adminAuth.as('admin').headers, 'x-organization-id': orgId });
const managerHeaders = () => ({ authorization: `Bearer ${branchManagerToken}`, 'x-organization-id': orgId });
const outsiderHeaders = () => ({ authorization: `Bearer ${outsiderToken}`, 'x-organization-id': orgId });
const noAuthHeaders = () => ({ 'x-organization-id': orgId });

async function signUpUser(email: string, name: string): Promise<{ token: string; userId: string }> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'TestPass123!', name },
  });
  const body = parse(res.body);
  return {
    token: (body?.token as string) ?? '',
    userId: ((body?.user as Record<string, unknown>)?.id as string) ?? '',
  };
}

async function verifyEmail(userId: string): Promise<void> {
  await mongoose.connection.db!.collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(userId) },
    { $set: { emailVerified: true } },
  );
}

async function signInUser(email: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: 'TestPass123!' },
  });
  return (parse(res.body)?.token as string) ?? '';
}

async function addMember(userId: string, role: string): Promise<void> {
  const { getAuth } = await import('#resources/auth/auth.config.js');
  await getAuth().api.addMember({
    body: { organizationId: orgId, userId, role },
  });
}

async function seedStock(sku: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, sku, qty, 5000);
}

async function getFulfillmentStatus(fulNumber: string, forOrderNumber: string = orderNumber): Promise<string | null> {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/fulfillments/for-order/${forOrderNumber}`,
    headers: adminHeaders(),
  });
  if (res.statusCode >= 400) return null;
  const body = parse(res.body) as Record<string, unknown> | null;
  // The handler spreads mongokit's pagination result at the top level —
  // `docs` is a sibling of `success`, not under `data` (matches the
  // arc-next list convention). Older test helpers read `body.docs`
  // and silently got zero items.
  const list = (body?.data as Array<Record<string, unknown>> | undefined) ?? [];
  const match = list.find((f) => f.fulfillmentNumber === fulNumber);
  return (match?.status as string) ?? null;
}

/**
 * Place a fresh order on the seeded product and create a fulfillment for it.
 * Each describe block that needs isolated state calls this so state from one
 * test group doesn't bleed into another.
 */
async function createOrderAndFulfillment(idempotencyKey: string): Promise<{ orderNumber: string; fulfillmentNumber: string }> {
  const orderRes = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: adminHeaders(),
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: productId,
          quantity: 1,
          unitPriceOverride: { amount: 50000, currency: 'BDT' },
        },
      ],
      customer: { email: 'buyer@test.com', name: 'Test Customer' },
      idempotencyKey,
    },
  });
  if (orderRes.statusCode >= 400) {
    throw new Error(`Order place failed: ${orderRes.statusCode} ${orderRes.body}`);
  }
  const orderBody = parse(orderRes.body);
  const newOrderNumber = ((orderBody as Record<string, unknown>)?.orderNumber) as string;

  const fulRes = await server.inject({
    method: 'POST',
    url: `${API}/fulfillments/for-order/${newOrderNumber}`,
    headers: adminHeaders(),
    payload: {
      fulfillmentType: 'physical',
      lines: [{ orderLineId: 'line_0', quantity: 1 }],
    },
  });
  if (fulRes.statusCode >= 400) {
    throw new Error(`Fulfillment create failed: ${fulRes.statusCode} ${fulRes.body}`);
  }
  const fulBody = parse(fulRes.body);
  const newFulNumber = ((fulBody as Record<string, unknown>)?.fulfillmentNumber) as string;
  return { orderNumber: newOrderNumber, fulfillmentNumber: newFulNumber };
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'fulfillment-perm',
    // Configure a RedX adapter so /logistics/webhooks/redx dispatches through
    // the carrier registry. `ingestWebhook` is pure — no HTTP — so a fake
    // key is safe.
    env: { REDX_API_KEY: 'test-redx-key-for-webhook-ingest' },
  });
  server = env.server;
  adminAuth = env.auth;
  orgId = env.orgId;

  const ts = Date.now();
  const mgrEmail = `fulfill-mgr-${ts}@test.com`;
  const outEmail = `fulfill-out-${ts}@test.com`;

  const mgr = await signUpUser(mgrEmail, 'Branch Manager');
  const out = await signUpUser(outEmail, 'Outsider');
  await Promise.all([verifyEmail(mgr.userId), verifyEmail(out.userId)]);
  await addMember(mgr.userId, 'branch_manager');
  // Outsider: intentionally NOT added to the branch.

  branchManagerToken = await signInUser(mgrEmail);
  outsiderToken = await signInUser(outEmail);
  if (!branchManagerToken || !outsiderToken) {
    throw new Error('Failed to sign in auxiliary users');
  }

  productSku = `FULFIL-SKU-${ts}`;

  // Insert catalog product directly — matches the pattern used by
  // cart-order-fulfillment-e2e (POST /products goes through extra Zod
  // validation that isn't relevant to this test's focus).
  const db = mongoose.connection.db!;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Fulfillment Test Product',
    slug: `fulfil-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 50000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: productSku } },
    shipping: { requiresShipping: true, weight: 250 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  productId = prod.insertedId.toString();

  // Simple products (no variants) resolve to skuRef = productId via CatalogBridge.
  await seedStock(productId, 10);

  const orderRes = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: adminHeaders(),
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: productId,
          quantity: 2,
          unitPriceOverride: { amount: 50000, currency: 'BDT' },
        },
      ],
      customer: { email: 'buyer@test.com', name: 'Test Customer' },
      idempotencyKey: `fulfil-workflow-${ts}`,
    },
  });
  if (orderRes.statusCode >= 400) {
    throw new Error(`Order place failed: ${orderRes.statusCode} ${orderRes.body}`);
  }
  const orderBody = parse(orderRes.body);
  orderNumber = ((orderBody as Record<string, unknown>)?.orderNumber
    ?? (orderBody as Record<string, unknown>)?.order_number) as string;
  if (!orderNumber) {
    throw new Error(`Order number not found in response: ${orderRes.body}`);
  }

  const fulRes = await server.inject({
    method: 'POST',
    url: `${API}/fulfillments/for-order/${orderNumber}`,
    headers: adminHeaders(),
    payload: {
      fulfillmentType: 'physical',
      lines: [{ orderLineId: 'line_0', quantity: 2 }],
    },
  });
  if (fulRes.statusCode >= 400) {
    throw new Error(`Fulfillment create failed: ${fulRes.statusCode} ${fulRes.body}`);
  }
  const fulBody = parse(fulRes.body);
  fulfillmentNumber = ((fulBody as Record<string, unknown>)?.fulfillmentNumber) as string;
  expect(fulfillmentNumber).toMatch(/^FUL-/);
}, 180_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

describe('Fulfillment workflow — admin transitions with strong assertions', () => {
  it('admin can transition pick → pack → ship and status reflects each step', async () => {
    const pickRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: adminHeaders(),
      payload: { action: 'pick' },
    });
    expect(pickRes.statusCode, pickRes.body).toBeLessThan(400);
    expect(await getFulfillmentStatus(fulfillmentNumber)).toBe('picking');

    const packRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: adminHeaders(),
      payload: { action: 'pack' },
    });
    expect(packRes.statusCode, packRes.body).toBeLessThan(400);
    expect(await getFulfillmentStatus(fulfillmentNumber)).toBe('packed');

    const shipRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: adminHeaders(),
      payload: { action: 'ship' },
    });
    expect(shipRes.statusCode, shipRes.body).toBeLessThan(400);
    expect(await getFulfillmentStatus(fulfillmentNumber)).toBe('shipped');
  });
});

describe('Fulfillment workflow — branch_manager transitions', () => {
  it('branch_manager of the same branch can mark the fulfillment delivered', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: managerHeaders(),
      payload: { action: 'deliver' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    expect(await getFulfillmentStatus(fulfillmentNumber)).toBe('delivered');
  });
});

describe('Fulfillment workflow — permission negative cases', () => {
  it('unauthenticated requests are rejected (401)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: noAuthHeaders(),
      payload: { action: 'deliver' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a non-member of the branch cannot transition fulfillment (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: outsiderHeaders(),
      payload: { action: 'deliver' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Fulfillment workflow — invalid transitions are rejected', () => {
  let freshOrder: string;
  let freshFul: string;

  beforeAll(async () => {
    const created = await createOrderAndFulfillment(`fulfil-invalid-${Date.now()}`);
    freshOrder = created.orderNumber;
    freshFul = created.fulfillmentNumber;
  }, 60_000);

  it("cannot 'deliver' before 'ship' — FSM rejects the transition", async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${freshFul}/action`,
      headers: adminHeaders(),
      payload: { action: 'deliver' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    // Status must still be the initial pending/picking state, not delivered.
    const status = await getFulfillmentStatus(freshFul, freshOrder);
    expect(status).not.toBe('delivered');
  });

  it("cannot transition to an unknown action", async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${freshFul}/action`,
      headers: adminHeaders(),
      payload: { action: 'teleport' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('Fulfillment workflow — role boundary', () => {
  let staffToken: string;
  let cashierToken: string;
  let financeToken: string;
  let freshOrder: string;
  let freshFul: string;

  beforeAll(async () => {
    const ts = Date.now();
    const staffEmail = `fulfill-staff-${ts}@test.com`;
    const cashierEmail = `fulfill-cashier-${ts}@test.com`;
    const financeEmail = `fulfill-finance-${ts}@test.com`;

    const staff = await signUpUser(staffEmail, 'Store Staff');
    const cashier = await signUpUser(cashierEmail, 'Cashier');
    const finance = await signUpUser(financeEmail, 'Finance Admin');
    await Promise.all([
      verifyEmail(staff.userId),
      verifyEmail(cashier.userId),
      verifyEmail(finance.userId),
    ]);
    await addMember(staff.userId, 'store_staff');
    await addMember(cashier.userId, 'cashier');
    await addMember(finance.userId, 'finance_admin');

    staffToken = await signInUser(staffEmail);
    cashierToken = await signInUser(cashierEmail);
    financeToken = await signInUser(financeEmail);

    const created = await createOrderAndFulfillment(`fulfil-roles-${ts}`);
    freshOrder = created.orderNumber;
    freshFul = created.fulfillmentNumber;
  }, 60_000);

  const headersWith = (token: string) => ({ authorization: `Bearer ${token}`, 'x-organization-id': orgId });

  it('store_staff of the branch can transition fulfillment (included in storeStaff group)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${freshFul}/action`,
      headers: headersWith(staffToken),
      payload: { action: 'pick' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    expect(await getFulfillmentStatus(freshFul, freshOrder)).toBe('picking');
  });

  it('cashier cannot transition fulfillment (403) — not in storeStaff/warehouseStaff groups', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${freshFul}/action`,
      headers: headersWith(cashierToken),
      payload: { action: 'pack' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('finance_admin cannot transition fulfillment (403) — different duty', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${freshFul}/action`,
      headers: headersWith(financeToken),
      payload: { action: 'pack' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Order action permissions — branch_manager can drive their branch orders', () => {
  async function placeOrder(idempotencyKey: string): Promise<string> {
    const orderRes = await server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: adminHeaders(),
      payload: {
        channel: 'web',
        orderType: 'standard',
        lines: [
          {
            kind: 'sku',
            offerId: productId,
            quantity: 1,
            unitPriceOverride: { amount: 50000, currency: 'BDT' },
          },
        ],
        customer: { email: 'buyer@test.com', name: 'Test Customer' },
        idempotencyKey,
      },
    });
    if (orderRes.statusCode >= 400) {
      throw new Error(`Order place failed: ${orderRes.statusCode} ${orderRes.body}`);
    }
    return ((parse(orderRes.body) as Record<string, unknown>)?.orderNumber) as string;
  }

  it('branch_manager can cancel an order placed at their branch', async () => {
    const ord = await placeOrder(`ord-cancel-mgr-${Date.now()}`);
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${ord}/action`,
      headers: managerHeaders(),
      payload: { action: 'cancel', reason: 'customer request' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect(data.status).toBe('canceled');
  });

  it('branch_manager can confirm a pending order', async () => {
    const ord = await placeOrder(`ord-confirm-mgr-${Date.now()}`);
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${ord}/action`,
      headers: managerHeaders(),
      payload: { action: 'confirm' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect(data.status).toBe('confirmed');
  });

  it('cashier cannot cancel an order (not in the manage-orders role set)', async () => {
    const ord = await placeOrder(`ord-cancel-cashier-${Date.now()}`);
    // signUp cashier token was created in the role-boundary describe; reuse it.
    // Fresh cashier to avoid coupling across describes:
    const ts = Date.now();
    const cashierEmail = `ord-cashier-${ts}@test.com`;
    const cashier = await signUpUser(cashierEmail, 'Cashier');
    await verifyEmail(cashier.userId);
    await addMember(cashier.userId, 'cashier');
    const cashToken = await signInUser(cashierEmail);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${ord}/action`,
      headers: { authorization: `Bearer ${cashToken}`, 'x-organization-id': orgId },
      payload: { action: 'cancel' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Fulfillment workflow — carrier webhook drives FSM transitions', () => {
  let webhookOrder: string;
  let webhookFul: string;
  const trackingNumber = `REDX-TRK-${Date.now()}`;

  beforeAll(async () => {
    const created = await createOrderAndFulfillment(`fulfil-webhook-${Date.now()}`);
    webhookOrder = created.orderNumber;
    webhookFul = created.fulfillmentNumber;

    // Advance to `shipped` so the RedX `delivered` webhook has a valid
    // source state (shipped → delivered).
    for (const action of ['pick', 'pack', 'ship']) {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/fulfillments/${webhookFul}/action`,
        headers: adminHeaders(),
        payload: { action },
      });
      if (res.statusCode >= 400) {
        throw new Error(`Advance to ${action} failed: ${res.statusCode} ${res.body}`);
      }
    }

    // Attach tracking so the webhook handler can look the fulfillment up
    // by `trackingInfo.trackingNumber`.
    const trackRes = await server.inject({
      method: 'PATCH',
      url: `${API}/fulfillments/${webhookFul}/tracking`,
      headers: adminHeaders(),
      payload: { carrier: 'redx', trackingNumber, trackingUrl: 'https://redx.com.bd/track' },
    });
    if (trackRes.statusCode >= 400) {
      throw new Error(`Tracking attach failed: ${trackRes.statusCode} ${trackRes.body}`);
    }
  }, 60_000);

  it('POST /logistics/webhooks/redx with status=delivered transitions fulfillment to delivered', async () => {
    // RedX payload shape — see packages/carrier-bd/src/adapters/redx.adapter.ts
    // `ingestWebhook`. `normalizeStatus('delivered', REDX_STATUS_MAP)` →
    // 'delivered', which `FULFILLMENT_FSM_MAP` maps to fulfillment state
    // 'delivered'.
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/webhooks/redx`,
      headers: {
        // Webhook endpoint is public (allowPublic), but the fulfillment
        // lookup uses x-organization-id — carrier webhooks in production
        // need a per-branch tracking-to-org mapping (gap flagged separately).
        'x-organization-id': orgId,
      },
      payload: {
        tracking_number: trackingNumber,
        status: 'delivered',
        message_en: 'Parcel delivered to recipient',
        timestamp: new Date().toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await getFulfillmentStatus(webhookFul, webhookOrder)).toBe('delivered');
  });
});
