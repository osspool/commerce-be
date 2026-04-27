/**
 * Quotation Routes — HTTP-level integration test through Fastify inject.
 *
 * Exercises the `/quotations` Arc resource end-to-end:
 *   - Auth (Better Auth bearer)
 *   - Permissions (orders.* via the resource definition)
 *   - Arc adapter auto-CRUD (list, get, create) wired to QuotationRepository
 *   - Stripe-style action endpoint POST /:quotationNumber/action
 *     for the FSM verbs (send, mark_viewed, accept, reject, expire,
 *     convert_to_order)
 *   - convert_to_order producing a real linked Order document
 *
 * This is the HTTP companion to `quotation-to-order.test.ts` (engine-level).
 * Together they pin the contract: the SDK calls these routes, so any
 * regression in route registration, action routing, or response envelopes
 * breaks the SDK + frontend.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts tests/integration/quotation-routes.test.ts
 */

// Env BEFORE imports — required by auth.config and app boot.
process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: TestAuthProvider;
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
    storeName: 'Quotation Routes Store',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function promoteUserRole(email: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne({ email }, { $set: { role: ['admin'] } });
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

  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `quotation-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Quotations-Store-${ts}`, slug: `quotations-${ts}` },
    users: [
      {
        key: 'admin',
        email: adminEmail,
        password: 'TestPass123!',
        name: 'Quotations Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;

  await promoteUserRole(adminEmail);

  // Re-login for fresh token reflecting admin role
  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const loginBody = parse(loginRes.body);
  const token = (loginBody?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: token });

  // Mark org as head office
  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'QUO-HO', isDefault: true, isActive: true } },
  );

  // Seed a catalog product so the order pipeline (used by convert_to_order)
  // can resolve line snapshots through the catalog bridge.
  const testSku = `QUO-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Quotation Test Widget',
    slug: `quotation-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 50000, currency: 'BDT' } } },
    identifiers: { custom: { sku: testSku } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  testProductId = prod.insertedId.toString();

  // Bootstrap branch + seed stock — convert_to_order goes through the order
  // pipeline which reserves stock via FlowBridge.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  await seedStock(flow, orgId, testSku, 1000, 5000);
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Helpers ────────────────────────────────────────────────────────────

const draftPayload = (suffix = '') => ({
  channel: 'b2b',
  orderType: 'standard',
  customerId: `cust-${suffix || Date.now()}`,
  customerSnapshot: { name: 'Acme Ltd', email: 'ops@acme.test' },
  lines: [
    {
      kind: 'sku',
      offerId: testProductId,
      quantity: 2,
      unitPriceOverride: { amount: 50000, currency: 'BDT' },
    },
  ],
  notes: `Quote ${suffix || 'inline'}`,
});

async function createDraft(suffix = '') {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/quotations`,
    headers: auth.as('admin').headers,
    payload: draftPayload(suffix),
  });
  if (res.statusCode >= 400) {
    throw new Error(`Quotation create failed: ${res.statusCode} ${res.body}`);
  }
  return parse(res.body)!.data as { _id: string; quotationNumber: string; status: string };
}

async function postAction(quotationNumber: string, action: string, extra: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: `${API}/quotations/${quotationNumber}/action`,
    headers: auth.as('admin').headers,
    payload: { action, ...extra },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Quotation Routes — registration', () => {
  it('GET /quotations is registered (Arc auto-list via adapter)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /quotations is registered (Arc auto-create via adapter)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/quotations`,
      headers: auth.as('admin').headers,
      payload: {},
    });
    // 400/422 from validation is fine — proves the route is wired.
    expect(res.statusCode).not.toBe(404);
  });

  it('POST /quotations/:id/action is registered (rejects unknown action with 400)', async () => {
    // Bypass the repo lookup: an unknown action name short-circuits in
    // createActionRouter BEFORE the handler runs. A 400 here proves the
    // route exists; a 404 would mean the route was never registered.
    // Arc's createActionRouter validates `action` against the registered
    // enum BEFORE the handler runs. An unknown action returns 400 — proving
    // the route exists. A 404 here would mean Arc never registered the route.
    const res = await postAction('QUO-anything', 'no_such_action');
    expect(res.statusCode).toBe(400);
    const body = parse(res.body)!;
    expect(body.success).toBe(false);
  });
});

describe('Quotation Routes — CRUD', () => {
  it('creates a draft quotation and assigns a QUO-prefixed number', async () => {
    const quote = await createDraft('cr');
    expect(quote.status).toBe('draft');
    expect(quote.quotationNumber).toMatch(/^QUO-\d{4}-\d+$/);
    expect(quote._id).toBeTruthy();
  });

  it('lists quotations scoped to the current branch', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body)!;
    const docs = (body.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const d of docs) expect(String(d.organizationId)).toBe(orgId);
  });

  it('GET /quotations/:quotationNumber returns the quote', async () => {
    const quote = await createDraft('get');
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations/${quote.quotationNumber}`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body)!;
    expect((body.data as Record<string, unknown>).quotationNumber).toBe(quote.quotationNumber);
  });
});

describe('Quotation Routes — FSM via /:id/action', () => {
  it('send: draft → sent stamps sentAt', async () => {
    const quote = await createDraft('send');
    const res = await postAction(quote.quotationNumber, 'send');
    expect(res.statusCode).toBe(200);
    const body = parse(res.body)!;
    const data = body.data as Record<string, unknown>;
    expect(data.status).toBe('sent');
    expect(data.sentAt).toBeTruthy();
  });

  it('mark_viewed: sent → viewed stamps viewedAt', async () => {
    const quote = await createDraft('view');
    await postAction(quote.quotationNumber, 'send');
    const res = await postAction(quote.quotationNumber, 'mark_viewed');
    expect(res.statusCode).toBe(200);
    const data = (parse(res.body)!.data as Record<string, unknown>);
    expect(data.status).toBe('viewed');
    expect(data.viewedAt).toBeTruthy();
  });

  it('accept: sent → accepted stamps acceptedAt', async () => {
    const quote = await createDraft('acc');
    await postAction(quote.quotationNumber, 'send');
    const res = await postAction(quote.quotationNumber, 'accept');
    expect(res.statusCode).toBe(200);
    const data = (parse(res.body)!.data as Record<string, unknown>);
    expect(data.status).toBe('accepted');
    expect(data.acceptedAt).toBeTruthy();
  });

  it('reject: stamps rejectedAt and rejectionReason (terminal)', async () => {
    const quote = await createDraft('rej');
    await postAction(quote.quotationNumber, 'send');
    const res = await postAction(quote.quotationNumber, 'reject', { reason: 'price too high' });
    expect(res.statusCode).toBe(200);
    const data = (parse(res.body)!.data as Record<string, unknown>);
    expect(data.status).toBe('rejected');
    expect(data.rejectedAt).toBeTruthy();
    expect(data.rejectionReason).toBe('price too high');
  });

  it('rejected is terminal — accept after reject is refused', async () => {
    const quote = await createDraft('rej-term');
    await postAction(quote.quotationNumber, 'send');
    await postAction(quote.quotationNumber, 'reject', { reason: 'declined' });
    const res = await postAction(quote.quotationNumber, 'accept');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('convert_to_order: produces a linked Order with ORD-prefixed number', async () => {
    const quote = await createDraft('conv');
    await postAction(quote.quotationNumber, 'send');
    await postAction(quote.quotationNumber, 'accept');

    const res = await postAction(quote.quotationNumber, 'convert_to_order', {
      channel: 'b2b',
      metadata: { source: 'quotation-routes-test' },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body)!;
    const result = body.data as { quotation: Record<string, unknown>; order: Record<string, unknown> };

    expect(result.quotation.status).toBe('converted');
    expect(result.quotation.convertedOrderNumber).toBeTruthy();
    expect(String(result.order.orderNumber)).toMatch(/^ORD-\d{4}-\d+$/);
    expect(result.quotation.convertedOrderNumber).toBe(result.order.orderNumber);
  });

  it('convert_to_order: re-converting an already-converted quote is rejected (idempotency)', async () => {
    const quote = await createDraft('conv-idem');
    await postAction(quote.quotationNumber, 'send');
    await postAction(quote.quotationNumber, 'accept');
    const first = await postAction(quote.quotationNumber, 'convert_to_order');
    expect(first.statusCode).toBe(200);

    const second = await postAction(quote.quotationNumber, 'convert_to_order');
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('unknown action name is rejected with 4xx', async () => {
    const quote = await createDraft('unk');
    const res = await postAction(quote.quotationNumber, 'wat_action_is_this');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
