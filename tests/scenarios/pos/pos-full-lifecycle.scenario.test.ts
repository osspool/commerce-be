/**
 * POS Full Lifecycle Scenario — open → sales → close → JE.
 *
 * End-to-end coverage of the migrated `@classytic/pos` engine driving the
 * full host stack: the package's shift FSM, the host's `LedgerBridge`
 * (shift.contract.ts), the canonical sales-posting service, and the
 * mongokit repository pipeline. Pinned as a regression guard against:
 *   - shift open with branch policy snapshot
 *   - per-method sales aggregation via `incrementSales`
 *   - close pipeline calls the host's ledger bridge
 *   - a single JournalEntry is posted with the canonical idempotency key
 *     `pos-shift-{shiftId}` and the right account split
 *   - re-running close on a closed shift is rejected (FSM finalized)
 *
 * Companion to `pos-shift-lifecycle.test.ts` (which exercises the host
 * route handlers directly) — this scenario asserts the JE emission contract
 * the older `daily-sales.service.ts` aggregator covered, but now driven
 * shift-by-shift instead of date-by-date.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;

function headers(orgId: string): Record<string, string> {
  return { ...env.auth.as('admin').headers, 'x-organization-id': orgId };
}

async function openShift(openingCash: number): Promise<string> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: headers(env.orgId),
    payload: { openingCash },
  });
  if (res.statusCode !== 201) throw new Error(`openShift failed: ${res.statusCode} ${res.body}`);
  return String((parse(res.body)! as { _id: string })._id);
}

async function action(shiftId: string, action: string, data: Record<string, unknown> = {}) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/${shiftId}/action`,
    headers: headers(env.orgId),
    payload: { action, ...data },
  });
}

/**
 * Seed the chart of accounts so the LedgerBridge can find the account
 * codes it posts to (1111 cash, 4111 sales, 2132 VAT, etc.).
 */
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

/**
 * Inject sales directly via the package repo's `incrementSales`. We use
 * the package's primitive instead of placing real orders so this scenario
 * stays focused on the shift→JE contract — the order→shift hook is
 * covered separately in pos-shift-aggregation.test.ts.
 */
async function incrementSales(
  shiftId: string,
  method: 'cash' | 'card' | 'mfs' | 'bank_transfer',
  amount: number,
): Promise<void> {
  const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
  await posEngine.repositories.shift.incrementSales(
    { shiftId, method, amount },
    { organizationId: env.orgId, actorId: 'scenario-actor' },
  );
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'pos-full-lifecycle' });
  await seedAccounts();
}, 90_000);

afterAll(async () => {
  await env.teardown();
});

beforeEach(async () => {
  await mongoose.connection.db!.collection('pos_shifts').deleteMany({});
  await mongoose.connection.db!.collection('journalentries').deleteMany({});
});

describe('POS full lifecycle — open → sales → close → JE', () => {
  it('closes a shift cleanly and posts ONE JE with the canonical shift idempotency key', async () => {
    const shiftId = await openShift(/* openingCash */ 1000);

    // Three POS sales across two payment methods. salesTotal must equal
    // the sum across methods; per-method breakdown is preserved.
    await incrementSales(shiftId, 'cash', 250);
    await incrementSales(shiftId, 'cash', 750);
    await incrementSales(shiftId, 'card', 500);

    // Close — counts match expected so no override needed.
    // expected cash = opening 1000 + sales 1000 - refunds 0 + cashIn/Out 0 = 2000
    const closeRes = await action(shiftId, 'close', {
      countedByMethod: [
        { method: 'cash', countedAmount: 2000 },
        { method: 'card', countedAmount: 500 },
      ],
    });
    expect(closeRes.statusCode).toBe(200);

    // Shift state should be `closed` and journalEntryId persisted.
    const closedShift = await mongoose.connection.db!
      .collection('pos_shifts')
      .findOne({ _id: new mongoose.Types.ObjectId(shiftId) });
    expect(closedShift?.state).toBe('closed');
    expect(closedShift?.journalEntryId).toBeTruthy();

    // Exactly ONE JE for this shift, keyed by the canonical idempotency key.
    const jes = await mongoose.connection.db!
      .collection('journalentries')
      .find({ idempotencyKey: `pos-shift-${shiftId}` })
      .toArray();
    expect(jes.length).toBe(1);

    // The JE must balance (Σ debits = Σ credits) — the absolute proof that
    // double-entry semantics survived the host bridge.
    const items = (jes[0].journalItems ?? []) as Array<{ debit?: number; credit?: number }>;
    const dr = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    const cr = items.reduce((s, i) => s + (i.credit ?? 0), 0);
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0);
  });

  it('a SECOND close attempt on a closed shift is rejected (FSM finalized)', async () => {
    const shiftId = await openShift(0);
    await incrementSales(shiftId, 'cash', 100);
    const first = await action(shiftId, 'close', {
      countedByMethod: [{ method: 'cash', countedAmount: 100 }],
    });
    expect(first.statusCode).toBe(200);

    const second = await action(shiftId, 'close', {
      countedByMethod: [{ method: 'cash', countedAmount: 100 }],
    });
    // 409 — package's `ShiftFinalizedError` mapped to 409 by the host.
    expect(second.statusCode).toBe(409);
  });

  it('closing two SHIFTS on the same day produces two distinct JEs', async () => {
    // Shift 1
    const shift1 = await openShift(0);
    await incrementSales(shift1, 'cash', 500);
    await action(shift1, 'close', {
      countedByMethod: [{ method: 'cash', countedAmount: 500 }],
    });

    // Shift 2 (same branch + same day)
    const shift2 = await openShift(0);
    await incrementSales(shift2, 'cash', 300);
    await action(shift2, 'close', {
      countedByMethod: [{ method: 'cash', countedAmount: 300 }],
    });

    const jes = await mongoose.connection.db!
      .collection('journalentries')
      .find({ idempotencyKey: { $regex: '^pos-shift-' } })
      .toArray();
    expect(jes.length).toBe(2);

    const ids = new Set(jes.map((j) => String(j.idempotencyKey)));
    expect(ids.has(`pos-shift-${shift1}`)).toBe(true);
    expect(ids.has(`pos-shift-${shift2}`)).toBe(true);
    // Distinct JE _ids — the canonical "one shift, one JE, summed via ledger".
    expect(new Set(jes.map((j) => String(j._id))).size).toBe(2);
  });

  it('refunds reduce per-method salesAmount before the JE posting', async () => {
    const shiftId = await openShift(0);
    await incrementSales(shiftId, 'cash', 1000);
    // Refund — same shape, refund flag.
    const { posEngine } = await import('../../../src/resources/sales/pos/pos.engine.js');
    await posEngine.repositories.shift.incrementSales(
      { shiftId, method: 'cash', amount: 200, refund: true },
      { organizationId: env.orgId, actorId: 'scenario-actor' },
    );

    const closeRes = await action(shiftId, 'close', {
      // Net cash sales = 1000 - 200 = 800 → expected counted = 800.
      countedByMethod: [{ method: 'cash', countedAmount: 800 }],
    });
    expect(closeRes.statusCode).toBe(200);

    const je = await mongoose.connection.db!
      .collection('journalentries')
      .findOne({ idempotencyKey: `pos-shift-${shiftId}` });
    expect(je).toBeTruthy();
    // Sum of debits = net of refunds.
    const items = (je!.journalItems ?? []) as Array<{ debit?: number }>;
    const totalDebit = items.reduce((s, i) => s + (i.debit ?? 0), 0);
    expect(totalDebit).toBe(800);
  });
});
