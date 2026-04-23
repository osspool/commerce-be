/**
 * Musok (VAT Invoice) E2E Integration Tests
 *
 * Covers:
 *   1. Mushak 6.3 generation — full lifecycle via POST /generate
 *   2. Idempotency — same source produces same invoice (no duplicate serials)
 *   3. CRUD — list, get via Arc adapter
 *   4. Serial sequencing — serials increment atomically
 *   5. Mushak 9.1 monthly return aggregation
 *   6. BIN validation endpoint
 *   7. Cancel action — Stripe pattern state transition
 *   8. Branch scoping — org-isolated queries
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';
import { computeCheckDigit } from '@classytic/bd-tax';

// ── Setup ──────────────────────────────────────────────────────────────────

let ctx: TestOrgContext;
let auth: AuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

function makeValidBIN(): string {
  const prefix = '001200045670';
  return prefix + String(computeCheckDigit(prefix) ?? 0);
}

async function seedPlatformConfig(sellerBin: string): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  await col.deleteMany({});
  await col.insertOne({
    isSingleton: true,
    platformName: 'Musok E2E Store',
    currency: 'BDT',
    vat: {
      isRegistered: true,
      bin: sellerBin,
      registeredName: 'Musok E2E Store Ltd',
      vatCircle: 'Dhaka South',
      defaultRate: 15,
      pricesIncludeVat: false,
    },
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const sellerBin = makeValidBIN();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }

  await seedPlatformConfig(sellerBin);

  // Clear musok data from prior runs
  const db = mongoose.connection.db!;
  await db.collection('musokinvoices').deleteMany({}).catch(() => {});
  await db.collection('musok_counters').deleteMany({}).catch(() => {});

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const ts = Date.now();

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
    org: { name: `MusokE2E-${ts}`, slug: `musok-e2e-${ts}` },
    users: [
      { key: 'admin', email: `musok-adm-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({
    tokens: { admin: ctx.users.admin.token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  // Ensure admin role
  await mongoose.connection.db!.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed a branch code on the org
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { code: 'HO-001' } },
  );
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ── Helpers ──

function generatePayload(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: new mongoose.Types.ObjectId().toString(),
    sourceModel: 'Order',
    buyer: { name: 'Test Customer', nid: '1234567890123' },
    items: [
      { description: 'Widget A', quantity: 2, unitPrice: 5000, vatRateCode: 'STANDARD' },
      { description: 'Widget B', quantity: 1, unitPrice: 10000, vatRateCode: 'REDUCED_5' },
    ],
    ...overrides,
  };
}

async function generateMusok(payload: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/musok/generate`,
    headers: auth.getHeaders('admin'),
    payload: generatePayload(payload),
  });
}

async function musokAction(id: string, action: string, extra: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/musok/${id}/action`,
    headers: auth.getHeaders('admin'),
    payload: { action, ...extra },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Mushak 6.3 Generation', () => {
  let firstInvoiceId: string;
  let firstSourceId: string;

  it('generates a Musok invoice with correct VAT calculation', async () => {
    firstSourceId = new mongoose.Types.ObjectId().toString();
    const res = await generateMusok({ sourceId: firstSourceId });
    const body = parse(res.body);

    expect(res.statusCode).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.mushakSerial).toMatch(/^HO-001\/\d{4}\/\d{6}$/);
    expect(body.data.seller.bin).toBe(sellerBin);
    expect(body.data.buyer.name).toBe('Test Customer');
    expect(body.data.lines).toHaveLength(2);

    // Widget A: 2 × 5000 = 10000 base, 15% VAT = 1500
    expect(body.data.lines[0].totalValue).toBe(10000);
    expect(body.data.lines[0].vatRate).toBe(15);
    expect(body.data.lines[0].vatAmount).toBe(1500);

    // Widget B: 1 × 10000 = 10000 base, 5% VAT = 500
    expect(body.data.lines[1].totalValue).toBe(10000);
    expect(body.data.lines[1].vatRate).toBe(5);
    expect(body.data.lines[1].vatAmount).toBe(500);

    // Totals
    expect(body.data.totalValue).toBe(20000);
    expect(body.data.totalVat).toBe(2000);
    expect(body.data.grandTotal).toBe(22000);
    expect(body.data.status).toBe('issued');

    firstInvoiceId = body.data._id;
  });

  it('is idempotent — same source returns same invoice', async () => {
    const res = await generateMusok({ sourceId: firstSourceId });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.data._id).toBe(firstInvoiceId);
  });

  it('increments serial number for new sources', async () => {
    const res1 = await generateMusok();
    const res2 = await generateMusok();

    const serial1 = parse(res1.body).data.serialNumber;
    const serial2 = parse(res2.body).data.serialNumber;

    expect(serial2).toBe(serial1 + 1);
  });

  it('handles SD + VAT correctly', async () => {
    const res = await generateMusok({
      items: [
        { description: 'Soft Drink', quantity: 10, unitPrice: 5000, vatRateCode: 'STANDARD', sdRate: 25 },
      ],
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(201);
    // Base: 50000, SD: 12500, VAT base: 62500, VAT: 9375
    expect(body.data.lines[0].sdAmount).toBe(12500);
    expect(body.data.totalSd).toBe(12500);
    expect(body.data.totalVat).toBe(9375);
    expect(body.data.grandTotal).toBe(71875);
  });
});

describe('CRUD via Arc Adapter', () => {
  // NOTE: Arc/mongokit's paginated list shape is `{ success, docs, page,
  // limit, total, hasNext, hasPrev }` — see @classytic/arc OpenAPI builder
  // at packages/arc/src/docs/openapi.ts. Earlier versions of these tests
  // asserted on `body.data` which never existed for list responses; they
  // were broken before Phase D and got fixed here as part of the cleanup.
  it('lists musok invoices with pagination', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.docs)).toBe(true);
    expect(body.docs.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(body.docs.length);
    expect(body.page).toBeDefined();
    expect(body.limit).toBeDefined();
  });

  it('gets a musok invoice by ID', async () => {
    // Get first invoice from list
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok?limit=1`,
      headers: auth.getHeaders('admin'),
    });
    const listBody = parse(listRes.body);
    const id = listBody.docs[0]._id;

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/${id}`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    // Single GET still uses { success, data } envelope.
    expect(body.data._id).toBe(id);
    expect(body.data.mushakSerial).toBeDefined();
  });

  it('filters by status', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok?status=issued`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    for (const inv of body.docs) {
      expect(inv.status).toBe('issued');
    }
  });
});

describe('Source Lookup', () => {
  it('finds musok invoice by source', async () => {
    const sourceId = new mongoose.Types.ObjectId().toString();
    await generateMusok({ sourceId });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/source/Order/${sourceId}`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(String(body.data.sourceId)).toBe(sourceId);
  });

  it('returns 404 for unknown source', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/source/Order/${fakeId}`,
      headers: auth.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('Cancel Action (Stripe Pattern)', () => {
  it('cancels an issued invoice', async () => {
    const genRes = await generateMusok();
    const id = parse(genRes.body).data._id;

    const res = await musokAction(id, 'cancel', { reason: 'Buyer refused delivery' });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('cancelled');
    expect(body.data.cancelReason).toBe('Buyer refused delivery');
  });

  it('rejects cancel on already cancelled invoice', async () => {
    const genRes = await generateMusok();
    const id = parse(genRes.body).data._id;

    await musokAction(id, 'cancel', { reason: 'First cancel' });
    const res = await musokAction(id, 'cancel', { reason: 'Double cancel' });

    expect(res.statusCode).toBe(400);
  });
});

describe('BIN Validation', () => {
  it('validates a correct BIN', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/validate-bin/${sellerBin}`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.data.isValid).toBe(true);
    expect(body.data.formatted).toMatch(/^\d{4}-\d{4}-\d{4}-\d$/);
  });

  it('rejects an invalid BIN', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/validate-bin/1234567890123`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.data.isValid).toBe(false);
  });
});

describe('Mushak 9.1 Monthly Return', () => {
  it('aggregates monthly VAT return', async () => {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/return/${period}`,
      headers: auth.getHeaders('admin'),
    });
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.data.return).toBeDefined();
    expect(body.data.return.period).toBe(period);
    expect(body.data.return.bin).toBe(sellerBin);
    expect(body.data.return.lines).toHaveLength(19);
    expect(body.data.return.netPayable).toBeGreaterThanOrEqual(0);
    expect(body.data.aggregates).toBeInstanceOf(Array);
  });

  it('rejects invalid period format', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/return/2026-13`,
      headers: auth.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Business-Type Scenarios ───────────────────────────────────────────────
//
// Per testing-infrastructure.md §6: each scenario is Setup → Script → Assert.
// We drive the booted Fastify app through HTTP, exercising the fiscal-position
// resolver + audit trail + branch.businessType branching wired in Phase D.
// All scenarios reuse the existing app boot (no extra MongoMemoryServer).

describe('Business-Type Scenario: STANDARD_VAT (default regime)', () => {
  it('domestic sale → 15% VAT, fiscal position NATIONAL, no SRO reference', async () => {
    const sourceId = new mongoose.Types.ObjectId().toString();

    // Setup — branch is on STANDARD_VAT by default (set during boot)
    // Script — POST a domestic Mushak 6.3 invoice
    const res = await generateMusok({
      sourceId,
      buyer: { name: 'Domestic Buyer Ltd', countryCode: 'BD' },
      items: [
        { description: 'Standard widget', quantity: 5, unitPrice: 10000, vatRateCode: 'STANDARD' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);

    // Assert — invoice has the audit trail with NATIONAL position
    expect(body.data.fiscalPosition).toBe('NATIONAL');
    expect(body.data.sroReference).toBeNull();
    expect(body.data.exemptionReason).toBeNull();
    // 15% of 50000 = 7500
    expect(body.data.totalVat).toBe(7500);
  });
});

describe('Business-Type Scenario: RMG_EXPORTER (foreign buyer remap)', () => {
  it('foreign buyer → fiscal position INTERNATIONAL, VAT zeroed, audit trail saved', async () => {
    const sourceId = new mongoose.Types.ObjectId().toString();

    // Script — same Mushak 6.3 endpoint, but buyer in US
    const res = await generateMusok({
      sourceId,
      buyer: { name: 'US Garments Importer LLC', countryCode: 'US' },
      items: [
        { description: 'Cotton T-shirts (export)', quantity: 100, unitPrice: 50000, vatRateCode: 'STANDARD' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);

    // Assert — fiscal position remapped, VAT zero (was STANDARD 15% pre-remap)
    expect(body.data.fiscalPosition).toBe('INTERNATIONAL');
    expect(body.data.sroReference).toBe('EXPORT-US');
    expect(body.data.exemptionReason).toMatch(/Export to US/);
    expect(body.data.totalVat).toBe(0); // Zero-rated export
    // Total value still records the export amount for monthly return reporting
    expect(body.data.totalValue).toBe(5_000_000);
  });
});

describe('Business-Type Scenario: Diplomatic mission (SRO-304/2018)', () => {
  it('isDiplomatic flag → DIPLOMATIC fiscal position with SRO reference', async () => {
    const sourceId = new mongoose.Types.ObjectId().toString();

    const res = await generateMusok({
      sourceId,
      buyer: {
        name: 'US Embassy Dhaka',
        countryCode: 'BD',
        isDiplomatic: true,
      },
      items: [
        { description: 'Office supply', quantity: 1, unitPrice: 200000, vatRateCode: 'STANDARD' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);

    expect(body.data.fiscalPosition).toBe('DIPLOMATIC');
    expect(body.data.sroReference).toBe('SRO-304/2018');
    expect(body.data.totalVat).toBe(0);
  });
});

describe('Business-Type Scenario: NGO without certificate is rejected', () => {
  it('isExemptNgo true + missing sroReference → 400 SRO_REFERENCE_REQUIRED', async () => {
    const res = await generateMusok({
      sourceId: new mongoose.Types.ObjectId().toString(),
      buyer: {
        name: 'BRAC',
        countryCode: 'BD',
        isExemptNgo: true,
        // sroReference deliberately missing
      },
      items: [{ description: 'Service', quantity: 1, unitPrice: 100000 }],
    });

    expect(res.statusCode).toBe(400);
    const body = parse(res.body);
    expect(body.code).toBe('SRO_REFERENCE_REQUIRED');
    expect(body.fiscalPositionReason).toMatch(/POSTING MUST BE REJECTED/);
  });

  it('NGO WITH certificate passes → EXEMPT_NGO position, certificate stored', async () => {
    const res = await generateMusok({
      sourceId: new mongoose.Types.ObjectId().toString(),
      buyer: {
        name: 'BRAC',
        countryCode: 'BD',
        isExemptNgo: true,
        sroReference: 'NGO-CERT-2026-042',
      },
      items: [{ description: 'Service', quantity: 1, unitPrice: 100000 }],
    });

    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.data.fiscalPosition).toBe('EXEMPT_NGO');
    expect(body.data.sroReference).toBe('NGO-CERT-2026-042');
  });
});

describe('Business-Type Scenario: SME_TOT branch files Mushak 9.2 (not 9.1)', () => {
  it('switches the monthly return form when branch.businessType = SME_TOT', async () => {
    // Setup — flip the branch to SME_TOT regime via direct DB update (the
    // canonical UI flow is "Platform Settings → Edit branch → businessType").
    await mongoose.connection.db!.collection('organization').updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.orgId) },
      { $set: { businessType: 'SME_TOT' } },
    );

    // Script — request the monthly return for any period
    const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/return/${period}`,
      headers: auth.getHeaders('admin'),
    });

    // Assert — handler branched to the 9.2 path
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.data.formType).toBe('9.2');
    expect(body.data.regime).toBe('SME_TOT');
    expect(body.data.return).toBeDefined();
    expect(body.data.return.totRate).toBe(4);

    // Cleanup — restore STANDARD_VAT for downstream tests
    await mongoose.connection.db!.collection('organization').updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.orgId) },
      { $set: { businessType: 'STANDARD_VAT' } },
    );
  });
});

describe('Business-Type Scenario: COTTAGE_EXEMPT files nothing', () => {
  it('returns formType=NONE when branch.businessType = COTTAGE_EXEMPT', async () => {
    await mongoose.connection.db!.collection('organization').updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.orgId) },
      { $set: { businessType: 'COTTAGE_EXEMPT' } },
    );

    const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/return/${period}`,
      headers: auth.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.data.formType).toBe('NONE');
    expect(body.data.regime).toBe('COTTAGE_EXEMPT');
    expect(body.data.message).toMatch(/no VAT.*filing required/i);

    // Restore for any downstream test runs
    await mongoose.connection.db!.collection('organization').updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.orgId) },
      { $set: { businessType: 'STANDARD_VAT' } },
    );
  });
});
