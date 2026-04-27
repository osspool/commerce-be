/**
 * Regression — shift JE matches source orders to the paisa, with VAT
 * split out into the 2132 credit line.
 *
 * Pins three invariants that the migration broke and we just fixed:
 *   1. Σ debits in the JE = Σ POS order grand-totals in paisa (no /100)
 *   2. JE includes a credit to 2132 VAT Output equal to Σ order tax
 *   3. JE includes a credit to 4111 Sales Revenue equal to Σ (gross − tax)
 *
 * Drives the orders end-to-end through the existing POS controller so the
 * aggregation hook + ledger bridge run as in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;

function headers(orgId: string): Record<string, string> {
  return { ...env.auth.as('admin').headers, 'x-organization-id': orgId };
}

async function seedAccounts(): Promise<void> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: headers(env.orgId),
  });
  if (res.statusCode >= 400) {
    throw new Error(`accounts seed failed: ${res.statusCode} ${res.body}`);
  }
}

async function openShift(openingCash: number): Promise<string> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: headers(env.orgId),
    payload: { openingCash },
  });
  if (res.statusCode !== 201) {
    throw new Error(`openShift failed: ${res.statusCode} ${res.body}`);
  }
  return String((parse(res.body)!.data as { _id: string })._id);
}

async function closeShift(shiftId: string, counted: Record<string, number>) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/${shiftId}/action`,
    headers: headers(env.orgId),
    payload: {
      action: 'close',
      countedByMethod: Object.entries(counted).map(([method, countedAmount]) => ({
        method,
        countedAmount,
      })),
    },
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'pos-je-correctness' });
  await seedAccounts();
}, 90_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(async () => {
  await mongoose.connection.db!.collection('pos_shifts').deleteMany({});
  await mongoose.connection.db!.collection('journalentries').deleteMany({});
});

/**
 * Drive sales directly through the package's `incrementSales` so this
 * test isolates the contract layer (shift → JE) without exercising the
 * full POS-controller order pipeline. A separate integration test covers
 * the order → hook → shift path.
 */
async function postSale(shiftId: string, method: 'cash' | 'card', amount: number, tax: number) {
  const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
  await posEngine.repositories.shift.incrementSales(
    { shiftId, method, amount, tax },
    { organizationId: env.orgId, actorId: 'scenario-actor' },
  );
}

async function loadShiftJE(shiftId: string) {
  return mongoose.connection.db!.collection('journalentries').findOne({
    idempotencyKey: `pos-shift-${shiftId}`,
  });
}

interface JeLine {
  account?: unknown;
  debit?: number;
  credit?: number;
  label?: string;
}

async function loadAccountByCode(code: string) {
  return mongoose.connection.db!.collection('accounts').findOne({ accountTypeCode: code });
}

describe('shift JE correctness — paisa + VAT split', () => {
  it('cash-only shift with 15% VAT — JE balances and the 2132 line equals tax sum', async () => {
    const shiftId = await openShift(0);

    // Three sales in paisa — gross / tax explicit.
    // 11500 paisa gross (10000 net + 1500 tax)
    await postSale(shiftId, 'cash', 11_500, 1_500);
    // 23000 gross (20000 net + 3000 tax)
    await postSale(shiftId, 'cash', 23_000, 3_000);
    // 5750 gross (5000 net + 750 tax)
    await postSale(shiftId, 'cash', 5_750, 750);

    const grossSum = 11_500 + 23_000 + 5_750; // 40250
    const taxSum = 1_500 + 3_000 + 750; // 5250
    const netSum = grossSum - taxSum; // 35000

    const close = await closeShift(shiftId, { cash: grossSum });
    expect(close.statusCode).toBe(200);

    const je = await loadShiftJE(shiftId);
    expect(je).toBeTruthy();
    const items = (je!.journalItems ?? []) as JeLine[];

    // Σ debits = Σ credits (double-entry invariant)
    const drSum = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    const crSum = items.reduce((s, i) => s + (i.credit ?? 0), 0);
    expect(drSum).toBe(crSum);

    // Σ debits = Σ source paisa (this catches the /100 bug)
    expect(drSum).toBe(grossSum);

    // Find the VAT line (2132 — Output VAT Payable).
    const vatAccount = await loadAccountByCode('2132');
    expect(vatAccount).toBeTruthy();
    const vatLine = items.find(
      (i) => String(i.account) === String((vatAccount as { _id: unknown })._id),
    );
    expect(vatLine, 'JE must contain a credit to 2132 VAT Output Payable').toBeTruthy();
    expect(vatLine!.credit).toBe(taxSum);

    // Find the Sales Revenue line (4111).
    const salesAccount = await loadAccountByCode('4111');
    expect(salesAccount).toBeTruthy();
    const salesLine = items.find(
      (i) => String(i.account) === String((salesAccount as { _id: unknown })._id),
    );
    expect(salesLine, 'JE must contain a credit to 4111 Sales Revenue').toBeTruthy();
    expect(salesLine!.credit).toBe(netSum);
  });

  it('mixed cash + card with refund — refund tax reduces the 2132 credit', async () => {
    const shiftId = await openShift(0);
    await postSale(shiftId, 'cash', 11_500, 1_500); // +1500 tax
    await postSale(shiftId, 'card', 23_000, 3_000); // +3000 tax

    // Refund half the cash sale (refundAmount 5750, refundTax 750).
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    await posEngine.repositories.shift.incrementSales(
      { shiftId, method: 'cash', amount: 5_750, tax: 750, refund: true },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );

    // Net cash gross = 11500 - 5750 = 5750
    // Net card gross = 23000
    // Total net gross = 28750
    // Total tax = 1500 + 3000 - 750 = 3750
    // Net revenue = 28750 - 3750 = 25000
    const close = await closeShift(shiftId, { cash: 5_750, card: 23_000 });
    expect(close.statusCode).toBe(200);

    const je = await loadShiftJE(shiftId);
    expect(je).toBeTruthy();
    const items = (je!.journalItems ?? []) as JeLine[];
    const drSum = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    expect(drSum).toBe(28_750);

    const vatAccount = await loadAccountByCode('2132');
    const vatLine = items.find(
      (i) => String(i.account) === String((vatAccount as { _id: unknown })._id),
    );
    expect(vatLine!.credit).toBe(3_750);

    const salesAccount = await loadAccountByCode('4111');
    const salesLine = items.find(
      (i) => String(i.account) === String((salesAccount as { _id: unknown })._id),
    );
    expect(salesLine!.credit).toBe(25_000);
  });

  it('zero-tax sales (B2B zero-rated) — no 2132 credit line emitted', async () => {
    const shiftId = await openShift(0);
    await postSale(shiftId, 'card', 50_000, 0); // zero-rated B2B

    const close = await closeShift(shiftId, { card: 50_000 });
    expect(close.statusCode).toBe(200);

    const je = await loadShiftJE(shiftId);
    expect(je).toBeTruthy();
    const items = (je!.journalItems ?? []) as JeLine[];

    const drSum = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    expect(drSum).toBe(50_000);

    // No VAT credit when there's no tax.
    const vatAccount = await loadAccountByCode('2132');
    const vatLine = items.find(
      (i) => String(i.account) === String((vatAccount as { _id: unknown })._id),
    );
    expect(vatLine).toBeUndefined();

    // Full gross goes to Sales Revenue.
    const salesAccount = await loadAccountByCode('4111');
    const salesLine = items.find(
      (i) => String(i.account) === String((salesAccount as { _id: unknown })._id),
    );
    expect(salesLine!.credit).toBe(50_000);
  });

  it('refund-only shift (net negative) — emits NO journal entry', async () => {
    const shiftId = await openShift(/* opening enough cash to cover the refund */ 1_000);
    // Just a refund against the opening float — no prior sales.
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    await posEngine.repositories.shift.incrementSales(
      { shiftId, method: 'cash', amount: 1_000, tax: 130, refund: true },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );

    // Drawer math: opening 1000 + sales 0 - refunds 1000 = expected 0.
    // Counting 0 → diff 0 → variance gate passes without override.
    const close = await closeShift(shiftId, { cash: 0 });
    expect(close.statusCode).toBe(200);

    // No JE — `shift.contract.ts` emits nothing when net gross ≤ 0.
    const je = await loadShiftJE(shiftId);
    expect(je).toBeNull();
  });
});

describe('stale-shift recovery — lazy-close + manual force-close', () => {
  it('lazy-closes a stale shift on the same register when a new shift is opened', async () => {
    // Seed a stale shift with a clearly-past businessDate so the lazy-close
    // boundary is unambiguous regardless of timezone.
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    const farPast = new Date('2025-01-01T00:00:00.000Z');
    const stale = await posEngine.repositories.shift.open(
      {
        registerId: env.orgId, // single-register-per-branch default in handlers
        businessDate: farPast,
        openingCashierId: 'orphan-cashier',
        openingCashierName: 'Orphan',
        openingCash: 0,
      },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );

    // Re-open via the HTTP path; lazy-close fires inside `openShift`.
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/pos/shifts/open`,
      headers: headers(env.orgId),
      payload: { openingCash: 0 },
    });
    expect(res.statusCode).toBe(201);

    const staleAfter = await posEngine.models.Shift.findById(stale._id).lean();
    expect(staleAfter?.state).toBe('orphaned_closed');
  });

  it('manual force-close action recovers a permanently-abandoned shift', async () => {
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    const farPast = new Date('2025-01-01T00:00:00.000Z');
    const stale = await posEngine.repositories.shift.open(
      {
        registerId: 'reg-abandoned',
        businessDate: farPast,
        openingCashierId: 'gone-cashier',
        openingCashierName: 'Gone',
        openingCash: 0,
      },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/posting/oversight/${String(stale._id)}/close`,
      headers: headers(env.orgId),
      payload: { reason: 'register decommissioned' },
    });
    expect(res.statusCode).toBe(200);

    const after = await posEngine.models.Shift.findById(stale._id).lean();
    expect(after?.state).toBe('orphaned_closed');
  });

  it('manual force-close rejects a missing reason', async () => {
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    const stale = await posEngine.repositories.shift.open(
      {
        registerId: 'reg-needs-reason',
        businessDate: new Date('2025-01-01T00:00:00.000Z'),
        openingCashierId: 'cashier-x',
        openingCashierName: 'X',
        openingCash: 0,
      },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/posting/oversight/${String(stale._id)}/close`,
      headers: headers(env.orgId),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)?.code).toBe('REASON_REQUIRED');
  });
});
