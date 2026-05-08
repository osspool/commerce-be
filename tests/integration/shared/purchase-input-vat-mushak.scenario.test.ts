/**
 * Purchase Input VAT -> Mushak 9.1 — Full E2E Scenario Test
 *
 * Proves the FULL purchase -> input VAT -> Mushak 9.1 flow works end-to-end:
 *
 *   1. Purchase with explicit VAT (15%) -> receive -> accounting event fires -> 1150.* debit
 *   2. POS sale -> output VAT -> Mushak 6.3 generation
 *   3. Mushak 9.1 monthly return shows inputVatCredit > 0 (THE key assertion)
 *   4. Zero-rated purchase -> no input VAT line
 *   5. Reduced-rate (7.5%) purchase -> input VAT NOT claimable per bd-tax rules
 *
 * Requires MongoMemoryReplSet (transactions) + full app boot with Better Auth.
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.FLOW_VALUATION_METHOD = 'fifo';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';
import { outbox } from '../../../src/shared/outbox/index.js';

let replSet: MongoMemoryReplSet;
let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;

const API = '/api/v1';
const VALID_BIN = '0012000456700';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  const base = {
    isSingleton: true,
    storeName: 'Input VAT Test Enterprise',
    platformName: 'Input VAT Test Ltd',
    currency: 'BDT',
    membership: { enabled: false },
    seo: {},
    social: {},
    vat: {
      bin: VALID_BIN,
      registeredName: 'Input VAT Test Ltd',
      vatCircle: 'Dhaka North',
      defaultRate: 15,
      pricesIncludeVat: false,
      isRegistered: true,
      activityType: 'retail',
    },
    updatedAt: new Date(),
  };
  if (!existing) {
    await col.insertOne({ ...base, createdAt: new Date() });
  } else {
    await col.updateOne({ isSingleton: true }, { $set: base });
  }
}

async function seedProduct(
  name: string,
  sku: string,
  price: number,
  costPrice: number,
  taxRate = 15,
  vatRateCode: 'STANDARD' | 'ZERO' | 'EXEMPT' = 'STANDARD',
) {
  const col = mongoose.connection.db!.collection('catalog_products');
  const doc: Record<string, unknown> = {
    name,
    slug: sku.toLowerCase(),
    status: 'active',
    type: 'simple',
    identifiers: { custom: { sku } },
    pricing: { basePrice: price, costPrice, taxRate },
    tax: { rate: taxRate, vatRateCode },
    variants: [{ sku, name, price, costPrice, isActive: true, taxRate, attributes: {} }],
    organizationId: null, // company-wide
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

// --- Setup ---

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();
  process.env.MONGO_URI = uri;

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  await seedPlatformConfig();

  const { resetAuth, getAuth } = await import('../../../src/resources/auth/auth.config.js');
  resetAuth();

  const { ensureCatalogEngine } = await import('../../../src/resources/catalog/catalog.engine.js');
  await ensureCatalogEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const ts = Date.now();

    const __testApp = await createApplication({ resources });

  // Force-create flow_* collections + indexes BEFORE any transactional
  // write fires. Without this, the FIRST PO receive races collection
  // creation inside a Mongo transaction and aborts with `Unable to write
  // to collection ... due to catalog changes; please retry the operation`
  // — see flow-engine.ts:99-105.
  const { ensureFlowEngineReady } = await import('../../../src/resources/inventory/flow/flow-engine.js');
  await ensureFlowEngineReady();

ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `IVAT-HQ-${ts}`, slug: `ivat-hq-${ts}` },
    users: [
      { key: 'admin', email: `ivat-admin-${ts}@test.com`, password: 'TestPass123!', name: 'IVAT Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  // Promote user to admin/superadmin/finance_admin roles
  await mongoose.connection.db!.collection('user').updateOne(
    { email: `ivat-admin-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin', 'finance_admin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { code: 'IVAT-HQ', branchType: 'store', branchRole: 'head_office', isDefault: true, isActive: true } },
  );
}, 120_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// --- Tests ---

describe('Purchase Input VAT -> Mushak 9.1 Scenario', () => {
  const SKU_STD = 'IVAT-STD-001';
  // PO inputs are BDT-major units (`computePurchaseTotals` does
  // `toPaisa(costPrice) = costPrice * 100`). Earlier comments here
  // labelled these as "in paisa" — that was wrong; passing 60000 sells
  // a ৳60,000/unit cost, not ৳600. Renamed below to make the unit
  // explicit so the JE-debit assertion lines up with what's actually
  // recorded (₹90,000 BDT VAT = 9,000,000 paisa).
  const PRICE_STD = 100000; // 1000 BDT major (PO input)
  const COST_STD = 60000;   // 600 BDT major (PO input — was mislabelled "paisa")
  const QTY_BUY = 10;

  const SKU_ZERO = 'IVAT-ZERO-001';
  const COST_ZERO = 40000;

  const SKU_REDUCED = 'IVAT-RED-001';
  const COST_REDUCED = 50000;

  let productStdId: string;
  let productZeroId: string;
  let productReducedId: string;
  let purchaseStdId: string;
  let purchaseZeroId: string;
  let purchaseReducedId: string;
  let orderId: string;

  // --- Seed products ---

  it('seeds products: standard-rated, zero-rated, reduced-rate', async () => {
    productStdId = await seedProduct('Standard Rate Widget', SKU_STD, PRICE_STD, COST_STD, 15, 'STANDARD');
    productZeroId = await seedProduct('Zero Rate Export Item', SKU_ZERO, 50000, COST_ZERO, 0, 'ZERO');
    productReducedId = await seedProduct('Reduced Rate Item', SKU_REDUCED, 80000, COST_REDUCED, 7.5, 'STANDARD');
    expect(productStdId).toBeTruthy();
    expect(productZeroId).toBeTruthy();
    expect(productReducedId).toBeTruthy();
  });

  // --- Scenario 1: Purchase with explicit VAT -> Receive -> Accounting event fires ---

  it('creates a purchase with taxRate: 15 and costPrice: 60000', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [
          { productId: productStdId, variantSku: SKU_STD, quantity: QTY_BUY, costPrice: COST_STD, taxRate: 15 },
        ],
        paymentTerms: 'credit',
        notes: 'Input VAT scenario test - standard-rated purchase',
      },
    });
    if (res.statusCode !== 201) console.log('Purchase create:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    purchaseStdId = body._id;
    expect(purchaseStdId).toBeTruthy();
  });

  it('receives the purchase via POST /inventory/purchase-orders/:id/action {receive}', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseStdId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'receive' },
    });
    if (res.statusCode !== 200) console.log('Purchase receive:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.status).toBe('received');
  });

  it('PURCHASES journal entry exists with input VAT debited to 1150.*', async () => {
    // Drain outbox to deliver the accounting:purchase.paid event emitted by receive
    await outbox.relay();
    // Let async event handlers settle (publish dispatches, doesn't await)
    await new Promise((r) => setTimeout(r, 300));

    const journalCol = mongoose.connection.db!.collection('journalentries');

    // Find the PURCHASES journal entry for this purchase
    const purchaseEntries = await journalCol.find({
      $or: [
        { 'sourceRef.sourceModel': 'PurchaseOrder', 'sourceRef.sourceId': purchaseStdId },
        { journalType: 'PURCHASES' },
      ],
    }).toArray();

    expect(purchaseEntries.length).toBeGreaterThan(0);

    // Journal items store `account` as an ObjectId ref. Resolve 1150.* account
    // codes to their ids, then match items by that ref.
    const input1150Accounts = await mongoose.connection
      .db!.collection('accounts')
      .find({ accountNumber: /^1150/ })
      .toArray();
    const input1150Ids = new Set(input1150Accounts.map((a) => a._id.toString()));

    const allItems = purchaseEntries.flatMap((e: any) => e.journalItems ?? e.items ?? []);
    const inputVatItems = allItems.filter((item: any) =>
      item.account && input1150Ids.has(item.account.toString()),
    );

    expect(inputVatItems.length).toBeGreaterThan(0);

    // Input VAT debit should be approximately 10 * 60000 * 0.15 = 90000 paisa
    const totalInputVat = inputVatItems.reduce((sum: number, item: any) => sum + (item.debit || 0), 0);
    expect(totalInputVat).toBeGreaterThan(0);

    // PO util `computeLineTotals` (purchase-order.utils.ts:44) treats
    // `costPrice` as BDT-major and converts to paisa via `* 100`. The
    // receive handler then converts the final taxTotal back to paisa for
    // the accounting event (`taxTotalPaisa = taxTotal * 100`), and the
    // contract debits that whole amount to `1150.VAT15.INPUT`.
    // So for `QTY_BUY=10` units at `COST_STD=60000` BDT/unit, 15% rate:
    //   subtotal = 600,000 BDT  ->  60,000,000 paisa
    //   taxTotal =  90,000 BDT  ->   9,000,000 paisa  ← the JE debit
    // Earlier comment on this line read "10 * 60000 paisa * 15% = 90000
    // paisa" — that mentally-treated the input as paisa when the backend
    // treats it as BDT-major, off by a factor of 100. The expression
    // below now matches what the production code actually records.
    const expectedVatPaisa = Math.round(QTY_BUY * COST_STD * 100 * 0.15);
    // Allow small rounding variance (+/- 100 paisa)
    expect(Math.abs(totalInputVat - expectedVatPaisa)).toBeLessThanOrEqual(100);
  });

  // --- Scenario 2: POS sale -> Output VAT -> Mushak 6.3 ---

  it('opens a POS shift (required before POS orders)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/shifts/open`,
      headers: auth.as('admin').headers,
      payload: { openingCash: 0 },
    });
    if (res.statusCode !== 201) console.log('Shift open:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
  });

  it('creates a POS sale for the standard-rated product', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [
          { productId: productStdId, variantSku: SKU_STD, quantity: 5, price: PRICE_STD },
        ],
        payments: [
          { method: 'cash', amount: 5 * PRICE_STD },
        ],
      },
    });
    if (res.statusCode !== 201) console.log('POS order:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    orderId = body._id;
    expect(orderId).toBeTruthy();
  });

  it('generates Mushak 6.3 from the POS order with totalVat > 0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/musok/generate`,
      headers: auth.as('admin').headers,
      payload: {
        sourceId: orderId,
        sourceModel: 'Order',
        buyer: { name: 'Walk-in Customer', address: 'Dhaka' },
        items: [
          {
            description: 'Standard Rate Widget',
            quantity: 5,
            unitPrice: PRICE_STD,
            vatRateCode: 'STANDARD',
            priceMode: 'exclusive',
          },
        ],
      },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      console.log('Musok generate:', res.statusCode, res.body);
    }
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.totalVat).toBeGreaterThan(0);
  });

  // --- Scenario 3: Mushak 9.1 monthly return shows input credit offset ---

  it('Mushak 9.1 return shows inputVatCredit > 0 (THE key assertion)', async () => {
    await outbox.relay();
    // Let async event handlers settle (publish dispatches, doesn't await)
    await new Promise((r) => setTimeout(r, 300));

    // Vendor-bill JEs land as DRAFT (matches ERPNext / Odoo review
    // semantics — see vendor-bill.contract.ts `autoPost: false`). The
    // tax aggregator only sums `state: 'posted'` entries because draft
    // amounts can still change. Post the bill JE before filing the
    // monthly return — that's what a real cashier does in the UI.
    const jeCol = mongoose.connection.db!.collection('journalentries');
    const draftPurchaseJes = await jeCol
      .find({ journalType: 'PURCHASES', state: 'draft' })
      .toArray();
    for (const je of draftPurchaseJes) {
      const r = await server.inject({
        method: 'POST',
        url: `${API}/accounting/journal-entries/${je._id}/action`,
        headers: auth.as('admin').headers,
        payload: { action: 'post' },
      });
      expect([200, 403]).toContain(r.statusCode);
    }

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/musok/return/${period}`,
      headers: auth.as('admin').headers,
    });
    if (res.statusCode !== 200) console.log('Musok return:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);

    const body = parse(res.body);
    expect(body).toBeDefined();

    const ret = body.return;
    expect(ret).toBeDefined();

    // THE KEY ASSERTION: inputVatCredit was previously always 0 before the fix.
    // Mushak 9.1 return is structured as NBR's 19-line format; line 9 is the
    // input VAT credit. Also exposed as body.inputVat from the handler.
    const inputCreditLine = ret?.lines?.find((l: { lineNumber: number }) => l.lineNumber === 9);
    const inputCredit = inputCreditLine?.value ?? 0;
    expect(inputCredit).toBeGreaterThan(0);

    // Output VAT aggregates should be present
    const aggregates = body.aggregates ?? [];
    expect(Array.isArray(aggregates)).toBe(true);
    const outputTotal = aggregates.reduce((sum: number, a: any) => sum + (a.vatAmount || 0), 0);

    // Net payable = output - input. Can be negative when input credit exceeds
    // output VAT for the period (normal for a first-month stock build-up — the
    // excess is carried forward to next month per NBR rules). The return's
    // netPayable field is floored at 0 by buildMushak91.
    if (outputTotal > 0) {
      const rawNet = outputTotal - inputCredit;
      expect(rawNet).toBeLessThan(outputTotal);
      expect(ret.netPayable).toBeGreaterThanOrEqual(0);
    }
  });

  // --- Scenario 4: Second purchase with ZERO rate -> no input VAT ---

  it('creates a zero-rated purchase (taxRate: 0)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [
          { productId: productZeroId, variantSku: SKU_ZERO, quantity: 5, costPrice: COST_ZERO, taxRate: 0 },
        ],
        paymentTerms: 'credit',
        notes: 'Zero-rated import - no input VAT expected',
      },
    });
    if (res.statusCode !== 201) console.log('Zero purchase create:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    purchaseZeroId = body._id;
    expect(purchaseZeroId).toBeTruthy();
  });

  it('receives the zero-rated purchase', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseZeroId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'receive' },
    });
    if (res.statusCode !== 200) console.log('Zero purchase receive:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).status).toBe('received');
  });

  it('zero-rated purchase journal entry does NOT have a 1150.* line', async () => {
    await outbox.relay();
    // Let async event handlers settle (publish dispatches, doesn't await)
    await new Promise((r) => setTimeout(r, 300));

    const journalCol = mongoose.connection.db!.collection('journalentries');

    // Find journal entries specifically for the zero-rated purchase
    const entries = await journalCol.find({
      'sourceRef.sourceModel': 'PurchaseOrder',
      'sourceRef.sourceId': purchaseZeroId,
    }).toArray();

    const input1150Accounts = await mongoose.connection
      .db!.collection('accounts')
      .find({ accountNumber: /^1150/ }, { projection: { _id: 1 } })
      .toArray();
    const input1150Ids = new Set(input1150Accounts.map((a) => a._id.toString()));

    const allItems = entries.flatMap((e: any) => e.journalItems ?? e.items ?? []);
    const inputVatItems = allItems.filter((item: any) =>
      item.account && input1150Ids.has(item.account.toString()),
    );

    // Zero-rate: no claimable input VAT
    expect(inputVatItems.length).toBe(0);
  });

  // --- Scenario 5: Purchase with reduced rate (7.5%) -> input VAT NOT claimable ---

  it('creates a reduced-rate purchase (taxRate: 7.5)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [
          { productId: productReducedId, variantSku: SKU_REDUCED, quantity: 5, costPrice: COST_REDUCED, taxRate: 7.5 },
        ],
        paymentTerms: 'credit',
        notes: 'Reduced rate (7.5%) purchase - input VAT not claimable per bd-tax',
      },
    });
    if (res.statusCode !== 201) console.log('Reduced purchase create:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    purchaseReducedId = body._id;
    expect(purchaseReducedId).toBeTruthy();
  });

  it('receives the reduced-rate purchase', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseReducedId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'receive' },
    });
    if (res.statusCode !== 200) console.log('Reduced purchase receive:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).status).toBe('received');
  });

  it('reduced-rate (7.5%) purchase journal entry does NOT have 1150.* line (not claimable per bd-tax)', async () => {
    await outbox.relay();
    // Let async event handlers settle (publish dispatches, doesn't await)
    await new Promise((r) => setTimeout(r, 300));

    const journalCol = mongoose.connection.db!.collection('journalentries');

    const entries = await journalCol.find({
      'sourceRef.sourceModel': 'PurchaseOrder',
      'sourceRef.sourceId': purchaseReducedId,
    }).toArray();

    const accountsCol = mongoose.connection.db!.collection('accounts');
    const input1150Accounts = await accountsCol
      .find({ accountNumber: /^1150/ }, { projection: { _id: 1 } })
      .toArray();
    const input1150Ids = new Set(input1150Accounts.map((a) => a._id.toString()));
    const inventory1165Accounts = await accountsCol
      .find({ accountNumber: /^1165/ }, { projection: { _id: 1 } })
      .toArray();
    const inventory1165Ids = new Set(inventory1165Accounts.map((a) => a._id.toString()));

    const allItems = entries.flatMap((e: any) => e.journalItems ?? e.items ?? []);
    const inputVatItems = allItems.filter((item: any) =>
      item.account && input1150Ids.has(item.account.toString()),
    );

    // Truncated/reduced rates are NOT claimable per bd-tax rules.
    // Full amount should be folded into inventory cost.
    expect(inputVatItems.length).toBe(0);

    // Verify that the full amount (including tax) is on the inventory account
    const inventoryItems = allItems.filter((item: any) =>
      item.account && inventory1165Ids.has(item.account.toString()),
    );
    if (inventoryItems.length > 0) {
      const totalInventoryDebit = inventoryItems.reduce((sum: number, item: any) => sum + (item.debit || 0), 0);
      // Full amount = 5 * 50000 * (1 + 0.075) = 268750 paisa
      // Since tax is folded into inventory, debit should equal the full gross amount
      const expectedGross = 5 * COST_REDUCED * 1.075;
      // Allow rounding variance
      expect(Math.abs(totalInventoryDebit - expectedGross)).toBeLessThanOrEqual(100);
    }
  });
});
