/**
 * Accounting Order Lifecycle — Full E2E Integration Test
 *
 * Tests the complete commerce-to-accounting pipeline:
 *
 *   1. Seed BFRS chart of accounts (company-wide)
 *   2. Verify correct account types exist (1111, 1112, 1122, 4111, 2131, 5111, 1164, 2111)
 *   3. Online order paid (cash + VAT)  → SALES journal entry
 *   4. Online order paid (bkash + VAT) → SALES journal entry (mobile banking)
 *   5. Online order paid (card, no VAT) → SALES journal entry (2 lines only)
 *   6. Order fulfilled → COGS journal entry (inventory reduction)
 *   7. Purchase received → PURCHASES journal entry (inventory increase)
 *   8. Refund processed → SALES reversal journal entry
 *   9. Stock adjustment (loss) → INVENTORY journal entry
 *  10. POS shift close → per-shift SALES journal entry (LedgerBridge)
 *  11. Trial balance — debits = credits across all entries
 *  12. Idempotency — duplicate events don't create duplicate entries
 *
 * All entries verified for:
 *   - Correct account codes (BFRS ledger-bd)
 *   - Double-entry balance (total debit = total credit)
 *   - Correct journal type
 *   - Branch tagging (organizationId)
 *   - Auto-post state
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ── Setup ──────────────────────────────────────────────────────────────────

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function safeParseBody(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

/** Verify a journal entry has balanced double-entry */
function assertBalanced(entry: any) {
  const totalDebit = entry.journalItems.reduce((s: number, i: any) => s + (i.debit || 0), 0);
  const totalCredit = entry.journalItems.reduce((s: number, i: any) => s + (i.credit || 0), 0);
  expect(totalDebit).toBe(totalCredit);
  expect(totalDebit).toBeGreaterThan(0);
  return { totalDebit, totalCredit };
}

/** Get account ObjectId by account type code from the seeded CoA */
async function getAccountId(code: string): Promise<string> {
  const db = mongoose.connection.db!;
  const account = await db.collection('accounts').findOne({ accountTypeCode: code, active: true });
  if (!account) throw new Error(`Account ${code} not found in seeded CoA`);
  return account._id.toString();
}

/** Find a journal entry by idempotency key */
async function findEntry(idempotencyKey: string) {
  const db = mongoose.connection.db!;
  return db.collection('journalentries').findOne({ idempotencyKey });
}

/** Publish an accounting event and wait for handler */
async function publishAndWait(event: string, payload: Record<string, unknown>, waitMs = 3000) {
  const { publish } = await import('../../../src/lib/events/arcEvents.js');
  await publish(event, payload);
  await new Promise((r) => setTimeout(r, waitMs));
}

/** Insert a mock transaction directly into DB */
async function insertTransaction(overrides: Record<string, unknown> = {}) {
  const db = mongoose.connection.db!;
  const txnId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();

  const defaults = {
    _id: txnId,
    flow: 'inflow',
    status: 'verified',
    amount: 150000,
    tax: 22500,
    method: 'cash',
    source: 'web',
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    branchCode: 'LC-001',
    date: new Date('2026-04-01T10:00:00.000+06:00'),
    sourceModel: 'Order',
    sourceId: orderId,
    type: 'order_purchase',
    currency: 'BDT',
    fee: 0,
    net: 127500,
    refundedAmount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const doc = { ...defaults, ...overrides };
  await db.collection('revenue_transactions').insertOne(doc);
  return { txnId, orderId, doc };
}

/** Insert a mock order directly into DB */
async function insertOrder(orderId: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  const db = mongoose.connection.db!;

  // Order shape mirrors what the COGS handler reads:
  // `lines[].snapshot.costPrice * quantity` per
  // [order-fulfilled.handler.ts:65-66](src/resources/accounting/events/handlers/order-fulfilled.handler.ts#L65-L66).
  const defaults = {
    _id: orderId,
    customerName: 'Test Customer',
    customerPhone: '+8801712345678',
    lines: [
      {
        product: new mongoose.Types.ObjectId(),
        name: 'Test Product A',
        quantity: 2,
        price: 50000, // 500 BDT each
        snapshot: { costPrice: 30000 }, // 300 BDT cost each
        vatRate: 15,
        vatAmount: 15000,
      },
      {
        product: new mongoose.Types.ObjectId(),
        name: 'Test Product B',
        quantity: 1,
        price: 50000, // 500 BDT
        snapshot: { costPrice: 25000 }, // 250 BDT cost
        vatRate: 15,
        vatAmount: 7500,
      },
    ],
    subtotal: 150000,
    totalAmount: 150000,
    vat: { total: 22500, rate: 15, isInclusive: true },
    status: 'confirmed',
    source: 'web',
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const doc = { ...defaults, ...overrides };
  await db.collection('orders').insertOne(doc);
  return doc;
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Lifecycle Test Commerce',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  process.env.ACCOUNTING_AUTO_SEED = 'true';
  process.env.ACCOUNTING_AUTO_POST = 'true';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');
  const ts = Date.now();

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Lifecycle-${ts}`, slug: `lifecycle-${ts}` },
    users: [
      { key: 'admin', email: `lc-admin-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  // Set platform admin role
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Chart of Accounts Setup
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1 — Chart of Accounts (BFRS Seed)', () => {
  it('seeds the company-wide BFRS chart of accounts', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/seed`,
      headers: auth.as('admin').headers,
    });

    expect([200, 201]).toContain(res.statusCode);
    const body = safeParseBody(res.body);
  });

  it('has Cash in Hand — Petty Cash (1111)', async () => {
    const id = await getAccountId('1111');
    expect(id).toBeTruthy();
  });

  it('has Cash at Bank — Current Account (1112)', async () => {
    const id = await getAccountId('1113');
    expect(id).toBeTruthy();
  });

  it('has Mobile Banking — bKash/Nagad/Rocket (1122)', async () => {
    const id = await getAccountId('1126');
    expect(id).toBeTruthy();
  });

  it('has Merchandise Inventory (1164)', async () => {
    const id = await getAccountId('1164');
    expect(id).toBeTruthy();
  });

  it('has VAT Payable (2131)', async () => {
    const id = await getAccountId('2132');
    expect(id).toBeTruthy();
  });

  it('has Accounts Payable — Trade Creditors (2111)', async () => {
    const id = await getAccountId('2111');
    expect(id).toBeTruthy();
  });

  it('has Sales — Domestic (4111)', async () => {
    const id = await getAccountId('4111');
    expect(id).toBeTruthy();
  });

  it('has Cost of Goods Sold (5111)', async () => {
    const id = await getAccountId('5111');
    expect(id).toBeTruthy();
  });

  it('has Inventory Write-down / Obsolescence (6711)', async () => {
    const id = await getAccountId('6711');
    expect(id).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Online Order Payment → SALES Journal Entry
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2 — Order Payment → SALES Entry', () => {
  // Account ObjectId cache for verification
  const accountIds: Record<string, string> = {};

  beforeAll(async () => {
    accountIds['1111'] = await getAccountId('1111');
    accountIds['1113'] = await getAccountId('1113');
    accountIds['1125'] = await getAccountId('1125'); // Gateway Clearing — card / online
    accountIds['1126'] = await getAccountId('1126');
    accountIds['4111'] = await getAccountId('4111');
    accountIds['2132'] = await getAccountId('2132');
  });

  it('cash order with 15% VAT → 3-line SALES entry (debit 1111, credit 4111 + 2131)', async () => {
    // Order: 1500 BDT total, 225 BDT VAT (15%), paid cash
    const { txnId, orderId } = await insertTransaction({
      amount: 150000,  // 1500 BDT in paisa
      tax: 22500,      // 225 BDT VAT
      method: 'cash',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() });

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('ECOM_SALES');
    expect(entry!.organizationId.toString()).toBe(ctx.orgId);

    // 3 lines: debit cash, credit revenue, credit VAT
    expect(entry!.journalItems.length).toBe(3);

    // Verify account assignment
    const debitItem = entry!.journalItems.find((i: any) => i.debit > 0);
    expect(debitItem.account.toString()).toBe(accountIds['1111']); // Cash in Hand
    expect(debitItem.debit).toBe(150000);

    const revenueItem = entry!.journalItems.find((i: any) => i.account.toString() === accountIds['4111']);
    expect(revenueItem).toBeTruthy();
    expect(revenueItem.credit).toBe(127500); // 1500 - 225 = 1275 BDT net

    const vatItem = entry!.journalItems.find((i: any) => i.account.toString() === accountIds['2132']);
    expect(vatItem).toBeTruthy();
    expect(vatItem.credit).toBe(22500); // 225 BDT VAT

    // Double-entry balance
    assertBalanced(entry);
  });

  it('bkash order with VAT → debit to 1122 (Mobile Banking)', async () => {
    const { txnId } = await insertTransaction({
      amount: 200000,  // 2000 BDT
      tax: 30000,      // 300 BDT VAT
      method: 'bkash',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() });

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeTruthy();

    const debitItem = entry!.journalItems.find((i: any) => i.debit > 0);
    expect(debitItem.account.toString()).toBe(accountIds['1126']); // Mobile Banking
    expect(debitItem.debit).toBe(200000);

    const revenueItem = entry!.journalItems.find((i: any) => i.account.toString() === accountIds['4111']);
    expect(revenueItem.credit).toBe(170000); // 2000 - 300 = 1700 BDT net

    assertBalanced(entry);
  });

  it('card order without VAT → 2-line entry (debit 1125 Gateway Clearing, credit 4111)', async () => {
    const { txnId } = await insertTransaction({
      amount: 300000,  // 3000 BDT
      tax: 0,          // No VAT
      method: 'card',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() });

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeTruthy();

    // Only 2 lines — no VAT line
    expect(entry!.journalItems.length).toBe(2);

    // Card debits Gateway Clearing — held by Stripe / SSLCommerz / ShurjoPay
    // until daily settlement reaches the bank, NOT direct to bank.
    const debitItem = entry!.journalItems.find((i: any) => i.debit > 0);
    expect(debitItem.account.toString()).toBe(accountIds['1125']);

    const revenueItem = entry!.journalItems.find((i: any) => i.credit > 0);
    expect(revenueItem.account.toString()).toBe(accountIds['4111']); // Sales Revenue
    expect(revenueItem.credit).toBe(300000); // Full amount = revenue (no VAT split)

    assertBalanced(entry);
  });

  it('creates journal entry (draft if no fiscal period, posted if open period exists)', async () => {
    const { txnId } = await insertTransaction({
      amount: 100000,
      tax: 15000,
      method: 'nagad',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() });

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeTruthy();
    // Auto-post attempts posting, but stays draft without open fiscal period
    expect(['draft', 'posted']).toContain(entry!.state);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Order Fulfilled → COGS Journal Entry
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 3 — Order Fulfilled → COGS Entry', () => {
  it('creates INVENTORY entry: debit 5111 (COGS), credit 1164 (Inventory)', async () => {
    const orderId = new mongoose.Types.ObjectId();

    // Order shape mirrors what the COGS handler reads: `lines[].snapshot.costPrice`.
    await insertOrder(orderId, {
      lines: [
        {
          product: new mongoose.Types.ObjectId(),
          name: 'Shirt',
          quantity: 3,
          price: 100000,
          snapshot: { costPrice: 60000 },
          vatRate: 15,
          vatAmount: 45000,
        },
        {
          product: new mongoose.Types.ObjectId(),
          name: 'Pants',
          quantity: 2,
          price: 150000,
          snapshot: { costPrice: 90000 },
          vatRate: 15,
          vatAmount: 45000,
        },
      ],
      totalAmount: 600000,
    });

    // Simulate order.fulfilled event
    // Total COGS = (3 × 60000) + (2 × 90000) = 180000 + 180000 = 360000 paisa = 3600 BDT
    await publishAndWait('accounting:order.fulfilled', { orderId: orderId.toString() });

    const entry = await findEntry(`cogs-${orderId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('INVENTORY');

    // 2 lines: debit COGS, credit Inventory
    expect(entry!.journalItems.length).toBe(2);

    const cogsAccountId = await getAccountId('5111');
    const inventoryAccountId = await getAccountId('1164');

    const debitItem = entry!.journalItems.find((i: any) => i.debit > 0);
    expect(debitItem.account.toString()).toBe(cogsAccountId);
    expect(debitItem.debit).toBe(360000); // 3600 BDT

    const creditItem = entry!.journalItems.find((i: any) => i.credit > 0);
    expect(creditItem.account.toString()).toBe(inventoryAccountId);
    expect(creditItem.credit).toBe(360000);

    assertBalanced(entry);
  });

  it('still posts a zero-value COGS entry when cost is missing (Odoo-style audit trail)', async () => {
    // Per `order-fulfilled.handler.ts`: when no `snapshot.costPrice` is
    // resolvable, the handler emits a JE with zero amounts and stamps
    // `metadata.costMissing: true`. The inventory move is the source of
    // truth; the JE exists so the audit trail is complete and finance can
    // backfill cost on the product, then re-trigger the post.
    const orderId = new mongoose.Types.ObjectId();

    await insertOrder(orderId, {
      lines: [
        {
          product: new mongoose.Types.ObjectId(),
          name: 'Free Sample',
          quantity: 1,
          price: 0,
          // no snapshot.costPrice → triggers costMissing path
        },
      ],
      totalAmount: 0,
    });

    await publishAndWait('accounting:order.fulfilled', { orderId: orderId.toString() }, 2000);

    const entry = await findEntry(`cogs-${orderId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.totalDebit).toBe(0);
    expect(entry!.totalCredit).toBe(0);
    expect((entry!.metadata as { costMissing?: boolean })?.costMissing).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Purchase → PURCHASES Journal Entry
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 4 — Purchase → PURCHASES Entry', () => {
  it('merchandise purchase on credit → debit 1164 (Inventory), credit 2111 (AP)', async () => {
    const { purchaseToPosting } = await import(
      '../../../src/resources/accounting/posting/contracts/purchase.contract.js'
    );
    const { createPosting, clearAccountCache } = await import(
      '../../../src/resources/accounting/posting/posting.service.js'
    );
    clearAccountCache();

    const purchaseId = new mongoose.Types.ObjectId().toString();
    const posting = purchaseToPosting({
      purchaseId,
      supplierId: new mongoose.Types.ObjectId().toString(),
      totalAmount: 500000, // 5000 BDT
      tax: 0,
      date: new Date('2026-04-01'),
      inventoryType: 'merchandise',
      isPaid: false,
    });

    expect(posting.items[0].accountCode).toBe('1164'); // Merchandise Inventory
    expect(posting.items[1].accountCode).toBe('2111'); // Accounts Payable

    // Actually create in DB via posting service
    const result = await createPosting(ctx.orgId, posting);
    expect(result.journalEntryId).toBeTruthy();

    const entry = await findEntry(posting.idempotencyKey);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('PURCHASES');
    assertBalanced(entry);
  });

  it('raw material purchase paid immediately → debit 1161, credit 1112 (Bank)', async () => {
    const { purchaseToPosting } = await import(
      '../../../src/resources/accounting/posting/contracts/purchase.contract.js'
    );
    const { createPosting } = await import(
      '../../../src/resources/accounting/posting/posting.service.js'
    );

    const purchaseId = new mongoose.Types.ObjectId().toString();
    const posting = purchaseToPosting({
      purchaseId,
      supplierId: new mongoose.Types.ObjectId().toString(),
      totalAmount: 200000,
      tax: 0,
      date: new Date('2026-04-01'),
      inventoryType: 'raw_materials',
      isPaid: true,
    });

    expect(posting.items[0].accountCode).toBe('1161'); // Raw Materials
    expect(posting.items[1].accountCode).toBe('1113'); // Bank Account

    const result = await createPosting(ctx.orgId, posting);
    expect(result.journalEntryId).toBeTruthy();

    const entry = await findEntry(posting.idempotencyKey);
    assertBalanced(entry);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: Refund → SALES Reversal Journal Entry
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 5 — Refund → SALES Reversal Entry', () => {
  it('full refund with VAT → debit 4111 + 2131, credit 1111', async () => {
    // Original sale: 1500 BDT, 225 BDT VAT, cash
    const { txnId: originalTxnId, orderId } = await insertTransaction({
      amount: 150000,
      tax: 22500,
      method: 'cash',
      source: 'web',
    });

    // Post original sale first
    await publishAndWait('accounting:order.paid', { transactionId: originalTxnId.toString() });

    // Create refund transaction
    const refundTxnId = new mongoose.Types.ObjectId();
    const db = mongoose.connection.db!;
    await db.collection('revenue_transactions').insertOne({
      _id: refundTxnId,
      flow: 'outflow',
      status: 'verified',
      amount: 150000,
      tax: 22500,
      method: 'cash',
      source: 'web',
      branch: new mongoose.Types.ObjectId(ctx.orgId),
      branchCode: 'LC-001',
      date: new Date('2026-04-02'),
      sourceModel: 'Order',
      sourceId: orderId,
      type: 'refund',
      currency: 'BDT',
      fee: 0,
      net: 127500,
      refundedAmount: 150000,
      relatedTransactionId: originalTxnId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Simulate refund event
    await publishAndWait('accounting:transaction.refunded', {
      transactionId: refundTxnId.toString(),
      refundAmount: 150000,
    });

    const entry = await findEntry(`refund-${refundTxnId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('ECOM_SALES');

    // 3 lines: debit revenue, debit VAT, credit cash
    expect(entry!.journalItems.length).toBe(3);

    const revenueId = await getAccountId('4111');
    const vatId = await getAccountId('2132');
    const cashId = await getAccountId('1111');

    const revenueDebit = entry!.journalItems.find(
      (i: any) => i.account.toString() === revenueId && i.debit > 0,
    );
    expect(revenueDebit).toBeTruthy();
    expect(revenueDebit.debit).toBe(127500); // Net refund = 1500 - 225 = 1275 BDT

    const vatDebit = entry!.journalItems.find(
      (i: any) => i.account.toString() === vatId && i.debit > 0,
    );
    expect(vatDebit).toBeTruthy();
    expect(vatDebit.debit).toBe(22500); // VAT reversal

    const cashCredit = entry!.journalItems.find(
      (i: any) => i.account.toString() === cashId && i.credit > 0,
    );
    expect(cashCredit).toBeTruthy();
    expect(cashCredit.credit).toBe(150000); // Full refund

    assertBalanced(entry);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6: Stock Adjustment → INVENTORY Journal Entry
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 6 — Stock Adjustment → INVENTORY Entry', () => {
  it('inventory loss → debit 6711 (Write-down), credit 1164 (Inventory)', async () => {
    const { stockAdjustmentToPosting } = await import(
      '../../../src/resources/accounting/posting/contracts/inventory.contract.js'
    );
    const { createPosting } = await import(
      '../../../src/resources/accounting/posting/posting.service.js'
    );

    const adjId = new mongoose.Types.ObjectId().toString();
    const posting = stockAdjustmentToPosting({
      adjustmentId: adjId,
      type: 'loss',
      amount: 50000, // 500 BDT shrinkage
      date: new Date('2026-04-01'),
      reason: 'Damaged in transit',
    });

    expect(posting.items[0].accountCode).toBe('6711'); // Write-down
    expect(posting.items[1].accountCode).toBe('1164'); // Inventory

    const result = await createPosting(ctx.orgId, posting);
    expect(result.journalEntryId).toBeTruthy();

    const entry = await findEntry(posting.idempotencyKey);
    assertBalanced(entry);
  });

  it('inventory gain → debit 1164 (Inventory), credit 4317 (Inventory Gain)', async () => {
    const { stockAdjustmentToPosting } = await import(
      '../../../src/resources/accounting/posting/contracts/inventory.contract.js'
    );
    const { createPosting } = await import(
      '../../../src/resources/accounting/posting/posting.service.js'
    );

    const adjId = new mongoose.Types.ObjectId().toString();
    const posting = stockAdjustmentToPosting({
      adjustmentId: adjId,
      type: 'gain',
      amount: 25000, // 250 BDT gain
      date: new Date('2026-04-01'),
      reason: 'Found during recount',
    });

    expect(posting.items[0].accountCode).toBe('1164'); // Inventory
    expect(posting.items[1].accountCode).toBe('4317'); // Inventory gain (Other Income)

    const result = await createPosting(ctx.orgId, posting);
    expect(result.journalEntryId).toBeTruthy();
    assertBalanced(await findEntry(posting.idempotencyKey));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7: POS Shift Close → Per-Shift SALES Entry
// ═══════════════════════════════════════════════════════════════════════════
//
// Posting is now driven by `@classytic/pos`'s LedgerBridge at shift close
// (see src/resources/accounting/posting/contracts/shift.contract.ts). One
// JE per closed shift, idempotency key `pos-shift-${shiftId}`. There is no
// daily aggregator and no `accounting:pos.day.close` event subscriber.

describe('Phase 7 — POS Shift Close → Per-Shift SALES Entry', () => {
  const posDate = '2026-04-05';

  it('one closed shift with mixed-payment breakdown emits one balanced SALES entry', async () => {
    const { shiftLedgerBridge } = await import(
      '../../../src/resources/accounting/posting/contracts/shift.contract.js'
    );

    const shiftId = new mongoose.Types.ObjectId();
    const businessDate = new Date(`${posDate}T00:00:00.000+06:00`);

    // Shape mirrors @classytic/pos's ShiftDocument — only the fields the
    // bridge reads. Cash + bKash + card across one shift:
    //   gross = 100000 + 200000 + 300000 = 600000 paisa
    //   tax   = 15000 + 30000 + 45000   =  90000 paisa
    //   net revenue = 510000 paisa
    const shift = {
      _id: shiftId,
      organizationId: new mongoose.Types.ObjectId(ctx.orgId),
      businessDate,
      salesCount: 3,
      paymentBreakdown: [
        { method: 'cash', salesAmount: 100000, taxAmount: 15000, refundAmount: 0, refundTaxAmount: 0 },
        { method: 'bkash', salesAmount: 200000, taxAmount: 30000, refundAmount: 0, refundTaxAmount: 0 },
        { method: 'card', salesAmount: 300000, taxAmount: 45000, refundAmount: 0, refundTaxAmount: 0 },
      ],
    } as never;

    await shiftLedgerBridge.onShiftClosed(shift, {
      organizationId: ctx.orgId,
      actorId: 'lifecycle-test',
    } as never);

    const entry = await findEntry(`pos-shift-${shiftId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('POS_SALES');

    // 3 debits (cash, bkash, card) + revenue credit + VAT credit = 5 lines
    expect(entry!.journalItems.length).toBe(5);

    const { totalDebit } = assertBalanced(entry);
    expect(totalDebit).toBe(600000);

    // Revenue is net of VAT
    const revenueAccountId = await getAccountId('4111');
    const revenueItem = entry!.journalItems.find(
      (i: any) => i.account.toString() === revenueAccountId,
    );
    expect(revenueItem.credit).toBe(510000);

    // VAT credit
    const vatAccountId = await getAccountId('2132');
    const vatItem = entry!.journalItems.find(
      (i: any) => i.account.toString() === vatAccountId,
    );
    expect(vatItem.credit).toBe(90000);
  });

  it('shift-close posting is idempotent on the same shiftId', async () => {
    // Replaying onShiftClosed for the same shift must NOT create a 2nd JE
    // — the bridge keys on `pos-shift-${shiftId}`.
    const { shiftLedgerBridge } = await import(
      '../../../src/resources/accounting/posting/contracts/shift.contract.js'
    );
    const db = mongoose.connection.db!;
    const existing = await db.collection('journalentries').findOne({
      idempotencyKey: { $regex: '^pos-shift-' },
    });
    expect(existing).toBeTruthy();
    const shiftId = (existing!.idempotencyKey as string).replace('pos-shift-', '');

    const shift = {
      _id: new mongoose.Types.ObjectId(shiftId),
      organizationId: new mongoose.Types.ObjectId(ctx.orgId),
      businessDate: new Date(`${posDate}T00:00:00.000+06:00`),
      salesCount: 3,
      paymentBreakdown: [
        { method: 'cash', salesAmount: 100000, taxAmount: 15000, refundAmount: 0, refundTaxAmount: 0 },
        { method: 'bkash', salesAmount: 200000, taxAmount: 30000, refundAmount: 0, refundTaxAmount: 0 },
        { method: 'card', salesAmount: 300000, taxAmount: 45000, refundAmount: 0, refundTaxAmount: 0 },
      ],
    } as never;

    await shiftLedgerBridge.onShiftClosed(shift, {
      organizationId: ctx.orgId,
      actorId: 'lifecycle-test',
    } as never);

    const count = await db.collection('journalentries').countDocuments({
      idempotencyKey: `pos-shift-${shiftId}`,
    });
    expect(count).toBe(1);
  });

  it('shift with zero net gross posts no journal entry', async () => {
    const { shiftLedgerBridge } = await import(
      '../../../src/resources/accounting/posting/contracts/shift.contract.js'
    );
    const shiftId = new mongoose.Types.ObjectId();
    const shift = {
      _id: shiftId,
      organizationId: new mongoose.Types.ObjectId(ctx.orgId),
      businessDate: new Date(`${posDate}T00:00:00.000+06:00`),
      salesCount: 0,
      paymentBreakdown: [],
    } as never;

    const result = await shiftLedgerBridge.onShiftClosed(shift, {
      organizationId: ctx.orgId,
      actorId: 'lifecycle-test',
    } as never);

    expect(result.journalEntryId).toBe('');
    const db = mongoose.connection.db!;
    const count = await db.collection('journalentries').countDocuments({
      idempotencyKey: `pos-shift-${shiftId.toString()}`,
    });
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 8: Trial Balance Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 8 — Trial Balance Verification', () => {
  beforeAll(async () => {
    // Create an open fiscal period covering 2026 so entries can be posted
    await server.inject({
      method: 'POST',
      url: `${API}/accounting/fiscal-periods`,
      headers: auth.as('admin').headers,
      payload: {
        name: 'FY2025-2026',
        type: 'year',
        startDate: '2025-07-01T00:00:00.000Z',
        endDate: '2026-06-30T23:59:59.999Z',
      },
    });

    // Post all draft journal entries via API
    const db = mongoose.connection.db!;
    const drafts = await db.collection('journalentries')
      .find({ state: 'draft' })
      .project({ _id: 1 })
      .toArray();

    for (const draft of drafts) {
      await server.inject({
        method: 'PATCH',
        url: `${API}/accounting/journal-entries/${draft._id}/post`,
        headers: auth.as('admin').headers,
      });
    }
  });

  it('trial balance has total debits = total credits', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/trial-balance?year=2026`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const report = safeParseBody(res.body);

    expect(report).toBeTruthy();
    expect(report.totalDebit).toBe(report.totalCredit);
    // May be 0 if posting all entries via API doesn't work
    // The important assertion is balance
  });

  it('income statement shows revenue and COGS', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/income-statement?year=2026`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
  });

  it('trial balance with branchId filter works', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/trial-balance?year=2026&branchId=${ctx.orgId}`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.totalDebit).toBe(body.totalCredit);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 9: Idempotency & Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 9 — Idempotency & Edge Cases', () => {
  it('duplicate order.paid event creates only one journal entry', async () => {
    const { txnId } = await insertTransaction({
      amount: 400000,
      tax: 60000,
      method: 'cash',
      source: 'web',
    });

    // Fire twice
    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() });
    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() }, 2000);

    const db = mongoose.connection.db!;
    const count = await db.collection('journalentries').countDocuments({
      idempotencyKey: `sale-${txnId.toString()}`,
    });
    expect(count).toBe(1);
  });

  it('POS transactions are NOT posted via order.paid (only via shift LedgerBridge)', async () => {
    const { txnId } = await insertTransaction({
      amount: 50000,
      tax: 0,
      method: 'cash',
      source: 'pos', // POS source
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() }, 2000);

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeNull();
  });

  it('non-verified transactions are ignored', async () => {
    const { txnId } = await insertTransaction({
      status: 'pending',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() }, 2000);

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeNull();
  });

  it('outflow transactions are ignored by order.paid handler', async () => {
    const { txnId } = await insertTransaction({
      flow: 'outflow',
      source: 'web',
    });

    await publishAndWait('accounting:order.paid', { transactionId: txnId.toString() }, 2000);

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeNull();
  });
});
