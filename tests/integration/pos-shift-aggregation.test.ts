/**
 * POS Shift Aggregation — integration tests.
 *
 * Covers:
 *   1. `applyShiftAggregation()` correctness — the hook's pure core
 *   2. Shift guard on POS controller — orders rejected when no active shift
 *
 * We test the aggregation function directly (not via the full order engine
 * pipeline) because the hook's contract is the `OrderCreateHookPayload`
 * shape, not "what @classytic/order emits." Testing the contract is
 * cheaper + more specific than standing up a full order pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';
import { applyShiftAggregation } from '#resources/sales/pos/shift-aggregation.hook.js';
import PosShift from '#resources/sales/pos/shift.model.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;

function headers() {
  return { ...env.auth.getHeaders('admin'), 'x-organization-id': env.orgId };
}

async function openShift(openingCash: number): Promise<string> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: headers(),
    payload: { openingCash },
  });
  if (res.statusCode !== 201) {
    throw new Error(`openShift failed: ${res.statusCode} ${res.body}`);
  }
  return String((parse(res.body)!.data as { _id: string })._id);
}

async function resetShifts() {
  await mongoose.connection.db!.collection('pos_shifts').deleteMany({});
}

/**
 * Build a synthetic order payload shaped like `@classytic/order` emits.
 * Money fields in minor units (paisa), same as the real engine.
 */
function buildOrderPayload(opts: {
  shiftId?: string;
  channel?: string;
  grandTotalMinor?: number; // paisa
  payments?: Array<{ method: string; amount: number }>; // BDT major units
  gateway?: string;
}) {
  return {
    result: {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: `POS-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      organizationId: env.orgId,
      channel: opts.channel ?? 'pos',
      totals: { grandTotal: { amount: opts.grandTotalMinor ?? 0, currency: 'BDT' } },
      ...(opts.gateway || opts.payments
        ? {
            payment: {
              gateway: opts.gateway ?? opts.payments?.[0]?.method ?? 'cash',
              paymentData: { payments: opts.payments ?? [] },
            },
          }
        : {}),
      metadata: opts.shiftId ? { shiftId: opts.shiftId } : {},
    },
  };
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'shift-agg' });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

beforeEach(async () => {
  await resetShifts();
});

// Aggregation function ──────────────────────────────────────────────────────

describe('applyShiftAggregation', () => {
  it('increments salesCount + salesTotal on the target shift', async () => {
    const shiftId = await openShift(100);
    const payload = buildOrderPayload({
      shiftId,
      grandTotalMinor: 50000, // 500 BDT
      payments: [{ method: 'cash', amount: 500 }],
    });

    const result = await applyShiftAggregation(payload);
    expect(result.applied).toBe(true);

    const shift = await PosShift.findById(shiftId).lean();
    expect(shift?.salesCount).toBe(1);
    expect(shift?.salesTotal).toBe(500);
  });

  it('updates paymentBreakdown per method via positional $', async () => {
    const shiftId = await openShift(100);
    const payload = buildOrderPayload({
      shiftId,
      grandTotalMinor: 100000, // 1000 BDT
      payments: [
        { method: 'cash', amount: 600 },
        { method: 'bkash', amount: 400 }, // mapped to 'mfs' bucket
      ],
    });

    await applyShiftAggregation(payload);
    const shift = await PosShift.findById(shiftId).lean();
    const cashRow = shift?.paymentBreakdown?.find((r) => r.method === 'cash');
    const mfsRow = shift?.paymentBreakdown?.find((r) => r.method === 'mfs');
    expect(cashRow?.salesAmount).toBe(600);
    expect(mfsRow?.salesAmount).toBe(400);
  });

  it('accumulates across multiple orders', async () => {
    const shiftId = await openShift(100);
    await applyShiftAggregation(
      buildOrderPayload({ shiftId, grandTotalMinor: 25000, payments: [{ method: 'cash', amount: 250 }] }),
    );
    await applyShiftAggregation(
      buildOrderPayload({ shiftId, grandTotalMinor: 75000, payments: [{ method: 'cash', amount: 750 }] }),
    );

    const shift = await PosShift.findById(shiftId).lean();
    expect(shift?.salesCount).toBe(2);
    expect(shift?.salesTotal).toBe(1000);
    const cashRow = shift?.paymentBreakdown?.find((r) => r.method === 'cash');
    expect(cashRow?.salesAmount).toBe(1000);
  });

  it('falls back to gateway field when payments[] is empty', async () => {
    const shiftId = await openShift(0);
    const payload = buildOrderPayload({
      shiftId,
      grandTotalMinor: 150000, // 1500 BDT
      gateway: 'cash',
    });
    await applyShiftAggregation(payload);
    const shift = await PosShift.findById(shiftId).lean();
    const cashRow = shift?.paymentBreakdown?.find((r) => r.method === 'cash');
    expect(cashRow?.salesAmount).toBe(1500);
  });

  it('skips non-POS orders (no-op, no error)', async () => {
    const shiftId = await openShift(100);
    const payload = buildOrderPayload({
      shiftId,
      channel: 'web', // ← not POS
      grandTotalMinor: 50000,
    });
    const result = await applyShiftAggregation(payload);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-pos');

    const shift = await PosShift.findById(shiftId).lean();
    expect(shift?.salesCount).toBe(0);
    expect(shift?.salesTotal).toBe(0);
  });

  it('skips POS orders with no shiftId in metadata', async () => {
    await openShift(100); // shift exists but order doesn't reference it
    const payload = buildOrderPayload({
      // no shiftId
      grandTotalMinor: 50000,
    });
    const result = await applyShiftAggregation(payload);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-shift-id');
  });

  it('silently no-ops when target shift is already closed', async () => {
    const shiftId = await openShift(100);
    // Manually close the shift.
    await PosShift.updateOne({ _id: shiftId }, { $set: { state: 'closed' } });

    const payload = buildOrderPayload({
      shiftId,
      grandTotalMinor: 50000,
      payments: [{ method: 'cash', amount: 500 }],
    });
    await applyShiftAggregation(payload);

    const shift = await PosShift.findById(shiftId).lean();
    // Counters untouched because filter requires state:open.
    expect(shift?.salesCount).toBe(0);
    expect(shift?.salesTotal).toBe(0);
  });

  it('maps bKash / Nagad / Rocket / Upay to "mfs" bucket', async () => {
    const shiftId = await openShift(0);
    for (const method of ['bkash', 'nagad', 'rocket', 'upay']) {
      await applyShiftAggregation(
        buildOrderPayload({
          shiftId,
          grandTotalMinor: 10000,
          payments: [{ method, amount: 100 }],
        }),
      );
    }
    const shift = await PosShift.findById(shiftId).lean();
    const mfsRow = shift?.paymentBreakdown?.find((r) => r.method === 'mfs');
    expect(mfsRow?.salesAmount).toBe(400);
  });
});

// POS controller shift guard ─────────────────────────────────────────────────

describe('POS controller shift guard', () => {
  it('rejects POST /pos/orders with NO_OPEN_SHIFT when no shift is open', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: headers(),
      payload: {
        items: [{ productId: 'p1', quantity: 1, price: 100 }],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = parse(res.body)!;
    expect(body.code).toBe('NO_OPEN_SHIFT');
  });

  it('rejects POST /pos/orders with SHIFT_NOT_OPEN when shift is paused', async () => {
    const shiftId = await openShift(100);
    // Move shift into paused state.
    await env.server.inject({
      method: 'POST',
      url: `${API}/pos/shifts/${shiftId}/action`,
      headers: headers(),
      payload: { action: 'pause' },
    });

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: headers(),
      payload: {
        items: [{ productId: 'p1', quantity: 1, price: 100 }],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = parse(res.body)!;
    expect(body.code).toBe('SHIFT_NOT_OPEN');
  });
});
