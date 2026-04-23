/**
 * Order → POS Shift aggregation hook.
 *
 * Listens to `after:create` on the order repo. For POS-channel orders that
 * carry a `metadata.shiftId`, atomically increments the shift's aggregates:
 *   - salesCount, salesTotal
 *   - paymentBreakdown[method].salesAmount
 *
 * Atomic via `$inc` + positional operator — no read/modify/write race.
 *
 * The hook is idempotent-safe: if the shift was already closed between the
 * order's create and this hook firing (rare), the update silently no-ops
 * because we match `state: 'open'` in the filter.
 *
 * Never throws. A logged warning on failure is better than a rolled-back
 * order — the sale already happened.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import type { ShiftPaymentMethod } from './shift.constants.js';
import PosShift from './shift.model.js';

interface PaymentLike {
  method?: string;
  amount?: number;
}

interface OrderCreateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    channel?: string;
    totals?: { grandTotal?: { amount?: number; currency?: string } };
    payment?: {
      gateway?: string;
      paymentData?: { payments?: PaymentLike[] };
    };
    metadata?: { shiftId?: string; [k: string]: unknown };
  };
}

/** Best-effort bucketing: raw gateway/method string → known shift method. */
function toShiftMethod(raw: string | undefined): ShiftPaymentMethod | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s === 'cash') return 'cash';
  if (s === 'card' || s.includes('visa') || s.includes('master') || s.includes('amex')) return 'card';
  if (s.includes('bkash') || s.includes('nagad') || s.includes('rocket') || s.includes('upay') || s === 'mfs') {
    return 'mfs';
  }
  if (s === 'bank_transfer' || s.includes('bank')) return 'bank_transfer';
  return null;
}

/**
 * Pure core of the hook — extracted so it's directly unit-testable without
 * spinning up the full order engine. The registered hook is a thin wrapper.
 */
export async function applyShiftAggregation(
  payload: OrderCreateHookPayload,
  logger?: FastifyBaseLogger,
): Promise<{ applied: boolean; reason?: string }> {
  const order = payload.result;
  if (!order || !order._id) return { applied: false, reason: 'no-order' };
  if (order.channel !== 'pos') return { applied: false, reason: 'not-pos' };

  const shiftId = order.metadata?.shiftId;
  if (!shiftId) {
    logger?.warn?.(
      { orderId: String(order._id), orderNumber: order.orderNumber },
      'POS order missing metadata.shiftId — shift aggregates not updated',
    );
    return { applied: false, reason: 'no-shift-id' };
  }

  // Amounts — order.totals.grandTotal is the authoritative sale figure.
  // Order money is stored in minor units (paisa); shift fields are in major
  // units (BDT). Divide by 100.
  const grandTotalMinor = order.totals?.grandTotal?.amount ?? 0;
  const salesTotal = grandTotalMinor / 100;

  // Per-payment-method split. Payments from the POS controller are already
  // in major units (user-entered amounts), so no division there.
  const payments = order.payment?.paymentData?.payments ?? [];
  const perMethod = new Map<ShiftPaymentMethod, number>();
  if (payments.length > 0) {
    for (const pm of payments) {
      const key = toShiftMethod(pm.method);
      if (!key) continue;
      perMethod.set(key, (perMethod.get(key) ?? 0) + (Number(pm.amount) || 0));
    }
  } else if (order.payment?.gateway) {
    const key = toShiftMethod(order.payment.gateway);
    if (key) perMethod.set(key, salesTotal);
  }

  try {
    await PosShift.updateOne({ _id: shiftId, state: 'open' }, { $inc: { salesCount: 1, salesTotal } });

    for (const [method, amount] of perMethod) {
      if (amount <= 0) continue;
      await PosShift.updateOne(
        { _id: shiftId, state: 'open', 'paymentBreakdown.method': method },
        { $inc: { 'paymentBreakdown.$.salesAmount': amount } },
      );
    }
    return { applied: true };
  } catch (err) {
    logger?.error?.(
      {
        err: (err as Error).message,
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        shiftId,
      },
      'Shift aggregation hook failed — order persisted, shift counts may drift',
    );
    return { applied: false, reason: 'update-failed' };
  }
}

let wired = false;

export function wireShiftAggregationHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  engine.repositories.order.on('after:create', async (payload: unknown) => {
    await applyShiftAggregation(payload as OrderCreateHookPayload, logger);
  });
}

/** Test-only — reset the wired guard between test engine boots. */
export function __resetShiftAggregationHookWiringForTests(): void {
  wired = false;
}
