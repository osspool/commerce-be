/**
 * POS Shift Lifecycle — integration tests.
 *
 * Covers the full state machine, variance gate, handover, blind close,
 * policy enforcement, and branch isolation.
 *
 * State machine coverage:
 *   open ─ pause ─→ paused ─ resume ─→ open
 *   open ─ cash-in / cash-out ─→ open
 *   open ─ blind-close ─→ blind_closed ─ reconcile ─→ closed
 *   open ─ close ─→ closed (variance gate)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, addSecondaryBranch, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;

// Utilities ────────────────────────────────────────────────────────────────

function headers(orgId: string) {
  return { ...env.auth.as('admin').headers, 'x-organization-id': orgId };
}

async function openShift(payload: { openingCash?: number }, orgId: string = env.orgId) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: headers(orgId),
    payload,
  });
}

async function action(
  shiftId: string,
  action: string,
  data: Record<string, unknown> = {},
  orgId: string = env.orgId,
) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/${shiftId}/action`,
    headers: headers(orgId),
    payload: { action, ...data },
  });
}

async function getCurrent(orgId: string = env.orgId) {
  return env.server.inject({
    method: 'GET',
    url: `${API}/pos/shifts/current`,
    headers: headers(orgId),
  });
}

async function setBranchPolicy(orgId: string, shiftPolicy: Record<string, unknown>) {
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { shiftPolicy } },
  );
}

async function resetShifts() {
  await mongoose.connection.db!.collection('pos_shifts').deleteMany({});
}

// Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'shift-life' });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

beforeEach(async () => {
  await resetShifts();
  // Clear any branch-level policy overrides between tests.
  await mongoose.connection.db!.collection('organization').updateMany(
    {},
    { $unset: { shiftPolicy: '' } },
  );
});

// Tests ─────────────────────────────────────────────────────────────────────

describe('open shift', () => {
  it('creates an open shift with policy snapshot + seeded paymentBreakdown', async () => {
    const res = await openShift({ openingCash: 300 });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body)!;
    const shift = body.data as Record<string, unknown>;

    expect(shift.state).toBe('open');
    expect(shift.openingCash).toBe(300);
    expect(shift.businessDate).toBeTruthy();
    expect(shift.policySnapshot).toBeTruthy();

    const methods = (shift.paymentBreakdown as Array<{ method: string; openingAmount: number }>).map((r) => r.method);
    expect(methods).toContain('cash');
    expect(methods).toContain('card');
    const cashRow = (shift.paymentBreakdown as Array<{ method: string; openingAmount: number }>).find((r) => r.method === 'cash');
    expect(cashRow?.openingAmount).toBe(300);
  });

  it('rejects a second open shift for the same branch (409)', async () => {
    await openShift({ openingCash: 100 });
    const res = await openShift({ openingCash: 200 });
    expect(res.statusCode).toBe(409);
    const body = parse(res.body)!;
    expect(body.success).toBe(false);
    expect(body.data).toBeTruthy(); // returns existing shift
  });

  it('enforces requiredOpeningFloat when set on branch policy', async () => {
    await setBranchPolicy(env.orgId, { requiredOpeningFloat: 500 });
    const bad = await openShift({ openingCash: 100 });
    expect(bad.statusCode).toBe(400);

    const good = await openShift({ openingCash: 500 });
    expect(good.statusCode).toBe(201);
  });

  it('derives businessDate from branch timezone', async () => {
    await setBranchPolicy(env.orgId, { autoCloseTimezone: 'Asia/Dhaka' });
    const res = await openShift({ openingCash: 0 });
    const shift = (parse(res.body)!.data as Record<string, unknown>);
    const bd = String(shift.businessDate);
    // ISO string — date part only, trailing Z means UTC midnight of BD day.
    expect(bd).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('current shift query', () => {
  it('returns null when no shift is open', async () => {
    const res = await getCurrent();
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)!.data).toBeNull();
  });

  it('returns the open shift after creation', async () => {
    await openShift({ openingCash: 100 });
    const res = await getCurrent();
    const data = parse(res.body)!.data as Record<string, unknown>;
    expect(data).toBeTruthy();
    expect(data.state).toBe('open');
  });
});

describe('cash movements', () => {
  async function openAndGetId(opening = 300): Promise<string> {
    const res = await openShift({ openingCash: opening });
    return String((parse(res.body)!.data as { _id: string })._id);
  }

  it('records cash-in with reason code + updates cashInAmount', async () => {
    const id = await openAndGetId();
    const res = await action(id, 'cash-in', {
      amount: 50, reasonCode: 'till_top_up', note: 'Added small notes',
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body)!;
    // Arc action wraps in {success, data} or returns the doc — handle both.
    const shift = (body.data ?? body) as Record<string, unknown>;
    expect((shift.cashMovements as unknown[]).length).toBe(1);
    const cashRow = (shift.paymentBreakdown as Array<{ method: string; cashInAmount: number }>).find((r) => r.method === 'cash');
    expect(cashRow?.cashInAmount).toBe(50);
  });

  it('rejects cash-in with no reasonCode when policy requires it', async () => {
    const id = await openAndGetId();
    const res = await action(id, 'cash-in', { amount: 50 });
    expect(res.statusCode).toBe(400);
  });

  it('rejects cash-in with a disallowed reasonCode', async () => {
    await setBranchPolicy(env.orgId, { allowedReasonCodes: ['till_top_up', 'correction'] });
    const id = await openAndGetId();
    const res = await action(id, 'cash-in', { amount: 50, reasonCode: 'owner_withdrawal' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects cash-out exceeding drawer balance', async () => {
    const id = await openAndGetId(300);
    const res = await action(id, 'cash-out', {
      amount: 500, reasonCode: 'bank_deposit', note: 'deposit',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-positive amounts', async () => {
    const id = await openAndGetId();
    const res = await action(id, 'cash-in', { amount: 0, reasonCode: 'correction' });
    expect(res.statusCode).toBe(400);
  });
});

describe('pause / resume (handover)', () => {
  async function openAndGetId(): Promise<string> {
    const res = await openShift({ openingCash: 100 });
    return String((parse(res.body)!.data as { _id: string })._id);
  }

  it('pause moves state open → paused and sets pausedAt', async () => {
    const id = await openAndGetId();
    const res = await action(id, 'pause', { notes: 'lunch' });
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('paused');
    expect(shift.pausedAt).toBeTruthy();
  });

  it('resume moves paused → open and sets resumedAt', async () => {
    const id = await openAndGetId();
    await action(id, 'pause');
    const res = await action(id, 'resume');
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('open');
    expect(shift.resumedAt).toBeTruthy();
  });

  it('pause rejected when allowHandover is disabled', async () => {
    await setBranchPolicy(env.orgId, { allowHandover: false });
    const id = await openAndGetId();
    const res = await action(id, 'pause');
    expect(res.statusCode).toBe(403);
  });

  it('resume rejected on a non-paused shift', async () => {
    const id = await openAndGetId();
    const res = await action(id, 'resume');
    expect(res.statusCode).toBe(409);
  });
});

describe('direct close (variance gate)', () => {
  async function openAndGetId(opening = 300): Promise<string> {
    const res = await openShift({ openingCash: opening });
    return String((parse(res.body)!.data as { _id: string })._id);
  }

  it('closes with zero variance — no override needed', async () => {
    const id = await openAndGetId(300);
    const res = await action(id, 'close', { countedCash: 300, notes: 'end of day' });
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('closed');
    expect(shift.closedBy).toBe('cashier');
    expect(shift.cashDifference).toBe(0);
  });

  it('closes with variance within threshold (50 BDT < 100 default)', async () => {
    const id = await openAndGetId(300);
    const res = await action(id, 'close', { countedCash: 350 });
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('closed');
    expect(shift.cashDifference).toBe(50);
  });

  it('rejects close with variance over threshold and no override', async () => {
    // Tighten threshold so a 200 BDT gap clearly violates.
    await setBranchPolicy(env.orgId, { varianceThresholdAbs: 50, varianceThresholdPct: 0.1 });
    const id = await openAndGetId(300);
    const res = await action(id, 'close', { countedCash: 500 });
    expect(res.statusCode).toBe(403);
  });

  it('accepts close with variance + manager override reason', async () => {
    await setBranchPolicy(env.orgId, { varianceThresholdAbs: 50, varianceThresholdPct: 0.1 });
    const id = await openAndGetId(300);
    const res = await action(id, 'close', {
      countedCash: 500,
      managerOverrideReason: 'Disputed; customer short-changed returned cash',
    });
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('closed');
    expect(shift.closedBy).toBe('manager');
    const approval = shift.varianceApproval as Record<string, unknown> | null;
    expect(approval).toBeTruthy();
    expect(approval!.status).toBe('approved');
  });

  it('rejects close on a policy that requires blind-close', async () => {
    await setBranchPolicy(env.orgId, { blindCloseRequired: true });
    const id = await openAndGetId(300);
    const res = await action(id, 'close', { countedCash: 300 });
    expect(res.statusCode).toBe(400);
  });
});

describe('blind close / reconcile', () => {
  async function openBlindBranch(opening = 300): Promise<string> {
    await setBranchPolicy(env.orgId, { blindCloseRequired: true });
    const res = await openShift({ openingCash: opening });
    return String((parse(res.body)!.data as { _id: string })._id);
  }

  it('blind-close moves open → blind_closed; counts recorded', async () => {
    const id = await openBlindBranch(300);
    const res = await action(id, 'blind-close', { countedCash: 320, notes: 'cashier count' });
    expect(res.statusCode).toBe(200);
    const shift = (parse(res.body)!.data ?? parse(res.body)) as Record<string, unknown>;
    expect(shift.state).toBe('blind_closed');
    expect(shift.blindClosedAt).toBeTruthy();
    expect(shift.countedCash).toBe(320);
    expect(shift.closingCashierId).toBeTruthy();
  });

  it('rejects reconcile by the same user who blind-closed (four-eyes)', async () => {
    const id = await openBlindBranch(300);
    await action(id, 'blind-close', { countedCash: 300 });
    const res = await action(id, 'reconcile', { notes: 'ok' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects close action on a blind_closed shift', async () => {
    const id = await openBlindBranch(300);
    await action(id, 'blind-close', { countedCash: 300 });
    const res = await action(id, 'close', { countedCash: 300 });
    expect(res.statusCode).toBe(409);
  });
});

describe('branch isolation (header-scoped, bearer-auth convention)', () => {
  let branchB: string;

  beforeAll(async () => {
    branchB = await addSecondaryBranch(env, { slug: 'shift-life-b', name: 'Branch B' });
  }, 60_000);

  it('open shift at A does not block opening at B', async () => {
    const a = await openShift({ openingCash: 100 }, env.orgId);
    expect(a.statusCode).toBe(201);
    const b = await openShift({ openingCash: 200 }, branchB);
    expect(b.statusCode).toBe(201);
  });

  it('/current is scoped by x-organization-id header', async () => {
    await openShift({ openingCash: 100 }, env.orgId);
    const resA = parse((await getCurrent(env.orgId)).body)!;
    expect((resA.data as { openingCash: number })?.openingCash).toBe(100);

    // Branch B has no shift (beforeEach cleared).
    const resB = parse((await getCurrent(branchB)).body)!;
    expect(resB.data).toBeNull();
  });

  it('closing branch A shift does not affect branch B shift', async () => {
    const aOpen = parse((await openShift({ openingCash: 100 }, env.orgId)).body)!;
    const aId = String((aOpen.data as { _id: string })._id);
    await openShift({ openingCash: 200 }, branchB);

    await action(aId, 'close', { countedCash: 100 }, env.orgId);

    const bCurrent = parse((await getCurrent(branchB)).body)!;
    expect((bCurrent.data as { state: string })?.state).toBe('open');
  });

  it('action on a shift whose branch differs from the header is rejected (403)', async () => {
    // Open at branch A, then try to close it claiming header: branchB.
    const aOpen = parse((await openShift({ openingCash: 100 }, env.orgId)).body)!;
    const aId = String((aOpen.data as { _id: string })._id);
    const res = await action(aId, 'close', { countedCash: 100 }, branchB);
    expect(res.statusCode).toBe(403);
  });
});
