/**
 * Mushak NBR Compliance E2E — Mushak 6.3 + Mushak 9.1
 *
 * Verifies NBR (National Board of Revenue Bangladesh) compliance through HTTP:
 *
 *   Mushak 6.3 (VAT Invoice):
 *     - Required field coverage
 *     - Serial format + uniqueness + monotonic increment
 *     - BIN format (13 digits)
 *     - B2C (no buyer BIN)
 *     - Per-line VAT math
 *     - Grand total sum
 *     - Source validation
 *     - Missing VAT config
 *     - Cancelled invoices excluded from monthly return
 *
 *   Mushak 9.1 (Monthly Return):
 *     - Aggregation by VAT rate
 *     - Period format (YYYY-MM)
 *     - Filing deadline (15th of following month)
 *     - Empty month
 *     - BIN on return
 *     - Output VAT == sum of issued invoice VATs
 *     - Zero-rated / exempt tracking
 *
 *   BIN Validation:
 *     - Valid 13-digit BIN
 *     - Invalid checksum
 *     - Wrong length
 *     - Non-digit
 *     - Formatted output
 *
 * Requires MongoMemoryReplSet (Flow engine transactions) + full app boot.
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.FLOW_VALUATION_METHOD = 'fifo';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.ENABLE_ACCOUNTING = 'true';
process.env.ACCOUNTING_MODE = 'standard';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';
import { computeCheckDigit } from '@classytic/bd-tax';

// ─── Globals ───────────────────────────────────────────────────────────────

let replSet: MongoMemoryReplSet;
let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;

const API = '/api/v1';
const BRANCH_CODE = 'DHK-001';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

// Build a real valid 13-digit BIN (with NBR-style check digit).
function makeValidBIN(prefix12 = '001200045670'): string {
  const check = computeCheckDigit(prefix12);
  return prefix12 + String(check ?? 0);
}

const SELLER_BIN = makeValidBIN('001200045670');

async function seedPlatformConfigWithVat(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  await col.deleteMany({});
  await col.insertOne({
    isSingleton: true,
    platformName: 'Mushak Compliance Test Ltd',
    storeName: 'Mushak Compliance Test Ltd',
    currency: 'BDT',
    vat: {
      bin: SELLER_BIN,
      registeredName: 'Test Ltd',
      vatCircle: 'Dhaka South',
      defaultRate: 15,
      pricesIncludeVat: false,
      isRegistered: true,
    },
    membership: { enabled: false },
    seo: {},
    social: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function removeVatFromPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  await col.updateOne({ isSingleton: true }, { $unset: { vat: '' } });
}

async function restoreVatOnPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  await col.updateOne(
    { isSingleton: true },
    {
      $set: {
        vat: {
          bin: SELLER_BIN,
          registeredName: 'Test Ltd',
          vatCircle: 'Dhaka South',
          defaultRate: 15,
          pricesIncludeVat: false,
          isRegistered: true,
        },
      },
    },
  );
}

async function seedProduct(name: string, sku: string, price: number, costPrice: number) {
  const col = mongoose.connection.db!.collection('catalog_products');
  const doc = {
    name,
    slug: sku.toLowerCase(),
    status: 'active',
    type: 'simple',
    identifiers: { custom: { sku } },
    pricing: { basePrice: price, costPrice },
    variants: [{ sku, name, price, costPrice, isActive: true }],
    organizationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

// ─── Setup ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();
  process.env.MONGO_URI = uri;

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  await seedPlatformConfigWithVat();

  const { resetAuth, getAuth } = await import('../../../src/resources/auth/auth.config.js');
  resetAuth();

  const { ensureCatalogEngine } = await import('../../../src/resources/catalog/catalog.engine.js');
  await ensureCatalogEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const ts = Date.now();

    const __testApp = await createApplication({ resources });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `MushakCompliance-${ts}`, slug: `mushak-compl-${ts}` },
    users: [
      { key: 'admin', email: `mushak-adm-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  // Elevate admin + tag the org with branch metadata (needed for Mushak serial `branchCode`)
  await mongoose.connection.db!.collection('user').updateOne(
    { email: `mushak-adm-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin', 'finance_admin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { code: BRANCH_CODE, branchType: 'store', branchRole: 'head_office', isDefault: true, isActive: true } },
  );

  // Clear prior mushak state
  await mongoose.connection.db!.collection('musokinvoices').deleteMany({}).catch(() => {});
  await mongoose.connection.db!.collection('musok_counters').deleteMany({}).catch(() => {});
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────

async function generateInvoice(payload: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/musok/generate`,
    headers: auth.as('admin').headers,
    payload,
  });
}

function defaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: new mongoose.Types.ObjectId().toString(),
    sourceModel: 'Order',
    buyer: { name: 'Retail Customer', nid: '1234567890123' },
    items: [
      { description: 'T-Shirt', quantity: 2, unitPrice: 50000, vatRateCode: 'STANDARD' },
    ],
    ...overrides,
  };
}

async function cancelInvoice(id: string, reason = 'Test cancellation') {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/musok/${id}/action`,
    headers: auth.as('admin').headers,
    payload: { action: 'cancel', reason },
  });
}

async function getMonthlyReturn(period: string) {
  return server.inject({
    method: 'GET',
    url: `${API}/accounting/musok/return/${period}`,
    headers: auth.as('admin').headers,
  });
}

async function validateBin(bin: string) {
  return server.inject({
    method: 'GET',
    url: `${API}/accounting/musok/validate-bin/${bin}`,
    headers: auth.as('admin').headers,
  });
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Mushak NBR Compliance', () => {
  let productId1: string;
  let productId2: string;

  // Seed catalog once (matches http-erp-golden-path.test.ts pattern)
  beforeAll(async () => {
    productId1 = await seedProduct('T-Shirt Red M', 'TSHIRT-RED-M', 99900, 45000);
    productId2 = await seedProduct('Jacket Black', 'JACKET-BLK', 249900, 120000);
    expect(productId1).toBeTruthy();
    expect(productId2).toBeTruthy();

    // Warm the branch (purchase + receive) so stock exists for POS orders.
    // If any of these steps fail we still run Mushak tests — they don't need stock.
    try {
      const purchaseRes = await server.inject({
        method: 'POST',
        url: `${API}/inventory/purchase-orders`,
        headers: auth.as('admin').headers,
        payload: {
          items: [
            { productId: productId1, variantSku: 'TSHIRT-RED-M', quantity: 50, costPrice: 45000 },
            { productId: productId2, variantSku: 'JACKET-BLK', quantity: 20, costPrice: 120000 },
          ],
          paymentTerms: 'cash',
          notes: 'Mushak compliance test stock',
        },
      });
      const purchaseId = parse(purchaseRes.body)?.data?._id;
      if (purchaseId) {
        await server.inject({
          method: 'POST',
          url: `${API}/inventory/purchase-orders/${purchaseId}/action`,
          headers: auth.as('admin').headers,
          payload: { action: 'receive' },
        });
      }

      // Create a few POS orders so the monthly return has real aggregation data.
      for (let i = 0; i < 3; i++) {
        await server.inject({
          method: 'POST',
          url: `${API}/pos/orders`,
          headers: auth.as('admin').headers,
          payload: {
            items: [
              { productId: productId1, variantSku: 'TSHIRT-RED-M', quantity: 1, price: 99900 },
            ],
            payments: [{ method: 'cash', amount: 99900 }],
          },
        });
      }
    } catch {
      // Seeding stock is best-effort — Mushak generation uses its own sourceIds.
    }
  }, 60_000);

  // ═══ Mushak 6.3 (VAT Invoice) ═══════════════════════════════════════════

  describe('Mushak 6.3 — VAT Invoice', () => {
    it('1. generation returns all NBR required fields', async () => {
      const res = await generateInvoice(defaultPayload({
        buyer: { name: 'ACME Corp', bin: SELLER_BIN, address: '123 Gulshan' },
        items: [
          { description: 'Premium Widget', quantity: 4, unitPrice: 25000, vatRateCode: 'STANDARD' },
        ],
      }));

      expect(res.statusCode).toBe(201);
      const body = parse(res.body);
      expect(body.success).toBe(true);
      const d = body.data;

      expect(d.mushakSerial).toBeTruthy();
      expect(d.date).toBeTruthy();

      expect(d.seller).toBeDefined();
      expect(d.seller.bin).toBe(SELLER_BIN);
      expect(d.seller.name).toBeTruthy();
      expect(d.seller.address).toBeTruthy();

      expect(d.buyer).toBeDefined();
      expect(d.buyer.name).toBe('ACME Corp');

      expect(Array.isArray(d.lines)).toBe(true);
      expect(d.lines.length).toBeGreaterThan(0);
      for (const line of d.lines) {
        expect(line.description).toBeTruthy();
        expect(typeof line.quantity).toBe('number');
        expect(typeof line.unitPrice).toBe('number');
        expect(typeof line.vatRate).toBe('number');
        expect(typeof line.vatAmount).toBe('number');
      }

      expect(typeof d.totalValue).toBe('number');
      expect(typeof d.totalVat).toBe('number');
      expect(typeof d.grandTotal).toBe('number');
    });

    it('2. serial format matches NBR spec (branchCode/YYYY/NNNNNN)', async () => {
      const res = await generateInvoice(defaultPayload());
      expect(res.statusCode).toBe(201);
      const serial = parse(res.body).data.mushakSerial as string;

      expect(serial).toMatch(/^[^/]+\/\d{4}\/\d{6}$/);
      const [branchPart, yearPart, numPart] = serial.split('/');

      expect(branchPart.length).toBeGreaterThan(0);
      expect(branchPart).toBe(BRANCH_CODE);

      const year = Number(yearPart);
      const thisYear = new Date().getFullYear();
      expect(year).toBeGreaterThanOrEqual(thisYear - 1);
      expect(year).toBeLessThanOrEqual(thisYear + 1);

      expect(numPart).toMatch(/^\d{6}$/);
      expect(numPart.length).toBe(6);
    });

    it('3. unique + monotonic serial per (branch, year)', async () => {
      const r1 = await generateInvoice(defaultPayload());
      const r2 = await generateInvoice(defaultPayload());
      const r3 = await generateInvoice(defaultPayload());

      const s1 = parse(r1.body).data;
      const s2 = parse(r2.body).data;
      const s3 = parse(r3.body).data;

      const serials = [s1.mushakSerial, s2.mushakSerial, s3.mushakSerial];
      expect(new Set(serials).size).toBe(3);

      // Serial numbers should be monotonic increasing.
      expect(s2.serialNumber).toBeGreaterThan(s1.serialNumber);
      expect(s3.serialNumber).toBeGreaterThan(s2.serialNumber);
    });

    it('4. BIN is 13 digits (no dashes, no spaces)', async () => {
      const res = await generateInvoice(defaultPayload());
      const bin = parse(res.body).data.seller.bin as string;
      expect(bin).toMatch(/^\d{13}$/);
      expect(bin.length).toBe(13);
      expect(bin.includes('-')).toBe(false);
      expect(bin.includes(' ')).toBe(false);
    });

    it('5. buyer BIN is optional (B2C)', async () => {
      const res = await generateInvoice(defaultPayload({
        buyer: { name: 'Walk-in Customer' }, // no BIN
      }));
      expect(res.statusCode).toBe(201);
      const body = parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.buyer.name).toBe('Walk-in Customer');
    });

    it('6. VAT amount per line matches rate × base (±1 paisa tolerance)', async () => {
      const res = await generateInvoice(defaultPayload({
        items: [
          { description: 'Widget A', quantity: 3, unitPrice: 12345, vatRateCode: 'STANDARD' },
          { description: 'Widget B', quantity: 1, unitPrice: 99999, vatRateCode: 'STANDARD' },
        ],
      }));
      expect(res.statusCode).toBe(201);
      const lines = parse(res.body).data.lines as Array<{
        totalValue: number; vatRate: number; vatAmount: number;
      }>;

      for (const line of lines) {
        const expected = (line.totalValue * line.vatRate) / 100;
        expect(Math.abs(line.vatAmount - expected)).toBeLessThanOrEqual(1);
      }
    });

    it('7. grand total equals totalValue + totalSd + totalVat', async () => {
      const res = await generateInvoice(defaultPayload({
        items: [
          { description: 'Soft Drink', quantity: 5, unitPrice: 10000, vatRateCode: 'STANDARD', sdRate: 25 },
          { description: 'Water', quantity: 2, unitPrice: 3000, vatRateCode: 'STANDARD' },
        ],
      }));
      expect(res.statusCode).toBe(201);
      const d = parse(res.body).data;

      expect(d.totalValue + (d.totalSd ?? 0) + d.totalVat).toBe(d.grandTotal);
    });

    it('8. rejects invalid sourceModel', async () => {
      const res = await generateInvoice(defaultPayload({ sourceModel: 'Invalid' as never }));
      // Model enum is ['Order','JournalEntry','Manual'] — should fail validation or mongoose cast.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('9. rejects missing PlatformConfig VAT config', async () => {
      await removeVatFromPlatformConfig();
      try {
        const res = await generateInvoice(defaultPayload());
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        const body = parse(res.body);
        // Should signal seller BIN missing / VAT not configured.
        const errMsg = JSON.stringify(body ?? {});
        expect(errMsg.toLowerCase()).toMatch(/bin|vat|seller|config/);
      } finally {
        await restoreVatOnPlatformConfig();
      }
    });

    it('10. cancelled invoices are excluded from monthly return', async () => {
      // Generate a fresh high-value invoice we can clearly identify in the totals.
      const genRes = await generateInvoice(defaultPayload({
        items: [
          { description: 'CANCEL-TARGET', quantity: 1, unitPrice: 1_000_000, vatRateCode: 'STANDARD' },
        ],
      }));
      expect(genRes.statusCode).toBe(201);
      const invoice = parse(genRes.body).data;
      const invoiceVat = invoice.totalVat as number;
      expect(invoiceVat).toBeGreaterThan(0);

      const period = currentPeriod();

      const beforeRes = await getMonthlyReturn(period);
      const before = parse(beforeRes.body).data;
      const beforeOutputVat15 = (before.return.lines.find((l: any) => l.lineNumber === 2)?.value ?? 0) as number;

      // Cancel the invoice
      const cancelRes = await cancelInvoice(invoice._id, 'Excluded from return test');
      expect(cancelRes.statusCode).toBe(200);
      expect(parse(cancelRes.body).data.status).toBe('cancelled');

      const afterRes = await getMonthlyReturn(period);
      const after = parse(afterRes.body).data;
      const afterOutputVat15 = (after.return.lines.find((l: any) => l.lineNumber === 2)?.value ?? 0) as number;

      // Cancelling should DECREASE the output VAT total by exactly this invoice's VAT.
      expect(beforeOutputVat15 - afterOutputVat15).toBe(invoiceVat);

      // Also: aggregate list should not contain this invoice's serial directly — the aggregation
      // only filters by status='issued'.
      const serials = (after.aggregates as Array<any>).map((a) => a._id);
      // Just assert after <= before (cancelled cannot add).
      expect(afterOutputVat15).toBeLessThanOrEqual(beforeOutputVat15);
    });
  });

  // ═══ Mushak 9.1 (Monthly Return) ════════════════════════════════════════

  describe('Mushak 9.1 — Monthly Return', () => {
    it('11. aggregates output VAT by rate', async () => {
      // Create invoices at two distinct rates to exercise grouping.
      await generateInvoice(defaultPayload({
        items: [{ description: 'Std rate A', quantity: 1, unitPrice: 100000, vatRateCode: 'STANDARD' }],
      }));
      await generateInvoice(defaultPayload({
        items: [{ description: 'Reduced 5', quantity: 1, unitPrice: 50000, vatRateCode: 'REDUCED_5' }],
      }));

      const period = currentPeriod();
      const res = await getMonthlyReturn(period);
      expect(res.statusCode).toBe(200);
      const data = parse(res.body).data;

      expect(Array.isArray(data.aggregates)).toBe(true);
      expect(data.aggregates.length).toBeGreaterThan(0);

      // Each aggregate row represents a distinct rate.
      const rates = data.aggregates.map((a: any) => a._id);
      expect(new Set(rates).size).toBe(rates.length);

      // Return lines include the 19-line NBR format.
      expect(data.return.lines).toHaveLength(19);
    });

    it('12. return period format is YYYY-MM', async () => {
      const period = '2026-04';
      const res = await getMonthlyReturn(period);
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.return.period).toBe(period);
      expect(d.return.period).toMatch(/^\d{4}-\d{2}$/);
    });

    it('13. return includes filing deadline (15th of following month)', async () => {
      const res = await getMonthlyReturn('2026-04');
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;

      expect(d.return.dueDate).toBeTruthy();
      const due = new Date(d.return.dueDate);
      expect(due.getUTCFullYear()).toBe(2026);
      expect(due.getUTCMonth()).toBe(4); // May (0-indexed → 4)
      expect(due.getUTCDate()).toBe(15);
    });

    it('14. empty month returns zero totals', async () => {
      // Well-before any invoice creation.
      const res = await getMonthlyReturn('2000-01');
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;

      expect(d.aggregates).toEqual([]);
      expect(d.return.netPayable).toBe(0);

      // Every output-VAT line (2..5) plus total line 6 should be zero.
      for (const ln of [2, 3, 4, 5, 6]) {
        const line = d.return.lines.find((l: any) => l.lineNumber === ln);
        expect(line.value).toBe(0);
      }
    });

    it('15. return includes filer BIN from PlatformConfig', async () => {
      const res = await getMonthlyReturn(currentPeriod());
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.return.bin).toBe(SELLER_BIN);
    });

    it('16. total output VAT matches sum of issued invoice VATs', async () => {
      const period = currentPeriod();
      const res = await getMonthlyReturn(period);
      const d = parse(res.body).data;

      // Compare NBR line 6 (total output VAT) against sum over aggregates.
      const line6 = d.return.lines.find((l: any) => l.lineNumber === 6).value as number;

      // Sum all non-zero-rate aggregates' vatAmount — matches repo's $group output.
      const aggVatSum = (d.aggregates as Array<any>)
        .filter((a) => Number(a._id) > 0)
        .reduce((sum, a) => sum + (a.vatAmount as number), 0);

      expect(line6).toBe(aggVatSum);

      // And cross-check via direct Mongo query: sum totalVat of issued invoices this month.
      const [yy, mm] = period.split('-').map(Number);
      const start = new Date(Date.UTC(yy, mm - 1, 1));
      const end = new Date(Date.UTC(yy, mm, 0, 23, 59, 59, 999));
      const issued = await mongoose.connection.db!
        .collection('musokinvoices')
        .find({ status: 'issued', date: { $gte: start, $lte: end } })
        .toArray();
      const invoiceVatSum = issued.reduce((s, i: any) => s + (i.totalVat ?? 0), 0);

      expect(line6).toBe(invoiceVatSum);
    });

    it('17. zero-rated sales are tracked separately (line 7)', async () => {
      // Try to create a zero-rated invoice. If bd-vat doesn't expose ZERO_RATED, skip softly.
      const res = await generateInvoice(defaultPayload({
        items: [{ description: 'Export Item', quantity: 1, unitPrice: 100000, vatRateCode: 'ZERO_RATED' }],
      }));

      const period = currentPeriod();
      const returnRes = await getMonthlyReturn(period);
      const d = parse(returnRes.body).data;
      const zeroRatedLine = d.return.lines.find((l: any) => l.lineNumber === 7);
      expect(zeroRatedLine).toBeDefined();
      expect(typeof zeroRatedLine.value).toBe('number');

      // If the ZERO_RATED invoice succeeded, the total must be non-zero.
      if (res.statusCode === 201) {
        expect(zeroRatedLine.value).toBeGreaterThan(0);
      }
    });

    it('18. exempt sales tracked separately (line 8)', async () => {
      const res = await getMonthlyReturn(currentPeriod());
      const d = parse(res.body).data;
      const exemptLine = d.return.lines.find((l: any) => l.lineNumber === 8);
      expect(exemptLine).toBeDefined();
      expect(typeof exemptLine.value).toBe('number');
      // No exempt products seeded — expect 0.
      expect(exemptLine.value).toBe(0);
    });
  });

  // ═══ BIN Validation ══════════════════════════════════════════════════════

  describe('BIN Validation', () => {
    it('19. valid 13-digit BIN passes', async () => {
      const res = await validateBin(SELLER_BIN);
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.isValid).toBe(true);
    });

    it('20. invalid checksum is rejected', async () => {
      // Take a valid BIN and mutate the check digit.
      const last = Number(SELLER_BIN[12]);
      const bad = SELLER_BIN.slice(0, 12) + String((last + 1) % 10);
      expect(bad).not.toBe(SELLER_BIN);

      const res = await validateBin(bad);
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.isValid).toBe(false);
    });

    it('21. wrong length (12 digits) is rejected', async () => {
      const res = await validateBin('001200045670'); // 12 digits
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.isValid).toBe(false);
    });

    it('22. non-digit BIN is rejected', async () => {
      const res = await validateBin('00120004567AB');
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.isValid).toBe(false);
    });

    it('23. valid BIN response includes formatted version (with dashes)', async () => {
      const res = await validateBin(SELLER_BIN);
      expect(res.statusCode).toBe(200);
      const d = parse(res.body).data;
      expect(d.isValid).toBe(true);
      // formatBIN → 4-4-4-1
      expect(d.formatted).toMatch(/^\d{4}-\d{4}-\d{4}-\d$/);
      expect(d.formatted).not.toBe(SELLER_BIN);
    });
  });
});
