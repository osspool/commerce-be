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
import type { ShiftPaymentMethod } from '@classytic/pos';
import type { FastifyBaseLogger } from 'fastify';
import { publish as publishEvent } from '#lib/events/arcEvents.js';
import { posEngine } from './pos.engine.js';

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
    totals?: {
      grandTotal?: { amount?: number; currency?: string };
      tax?: { amount?: number; currency?: string };
    };
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

  // Paisa (integer minor units) end-to-end. `totals.grandTotal.amount`
  // and `totals.tax.amount` are paisa; `paymentData.payments[].amount` is
  // also paisa (pos.controller stores it that way). The shift package
  // accumulates paisa; the host's ledger bridge posts paisa via the
  // existing accounting/posting service.
  const grandTotalPaisa = order.totals?.grandTotal?.amount ?? 0;
  const totalTaxPaisa = order.totals?.tax?.amount ?? 0;
  if (grandTotalPaisa <= 0) return { applied: false, reason: 'zero-total' };

  // Per-payment-method split — paisa.
  const payments = order.payment?.paymentData?.payments ?? [];
  const perMethod = new Map<ShiftPaymentMethod, number>();
  if (payments.length > 0) {
    for (const pm of payments) {
      const key = toShiftMethod(pm.method);
      if (!key) continue;
      const amt = Number(pm.amount) || 0;
      if (amt <= 0) continue;
      perMethod.set(key, (perMethod.get(key) ?? 0) + amt);
    }
  } else if (order.payment?.gateway) {
    const key = toShiftMethod(order.payment.gateway);
    if (key) perMethod.set(key, grandTotalPaisa);
  } else {
    // Defensive default — single cash bucket carrying the full grand total.
    perMethod.set('cash', grandTotalPaisa);
  }

  // Pro-rate the order's total tax across methods using each method's
  // share of the gross. Last bucket gets the rounding remainder so the
  // sum of method tax stays exactly equal to totals.tax.
  const methodEntries = Array.from(perMethod.entries());
  const grossSum = methodEntries.reduce((s, [, a]) => s + a, 0);
  const taxByMethod = new Map<ShiftPaymentMethod, number>();
  if (totalTaxPaisa > 0 && grossSum > 0) {
    let allocated = 0;
    methodEntries.forEach(([method, amount], idx) => {
      const isLast = idx === methodEntries.length - 1;
      const share = isLast
        ? totalTaxPaisa - allocated
        : Math.floor((totalTaxPaisa * amount) / grossSum);
      taxByMethod.set(method, share);
      allocated += share;
    });
  }

  try {
    const ctx = {
      organizationId:
        typeof order.organizationId === 'string'
          ? order.organizationId
          : order.organizationId?.toString?.() ?? '',
    };

    for (const [method, amount] of methodEntries) {
      const tax = taxByMethod.get(method) ?? 0;
      await posEngine.repositories.shift.incrementSales(
        { shiftId, method, amount, tax },
        ctx,
      );
    }

    // Fire-and-forget downstream signal. The shift-counter the cashier sees
    // is updated in-band above (atomic single $inc, <50ms). This event is
    // for downstream consumers — analytics, BI, audit dashboards — that
    // don't need real-time consistency. Published to the outbox via
    // arcEvents so failures here don't block or fail the order.
    publishEvent('pos:order.placed', {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      organizationId: ctx.organizationId,
      shiftId,
      grandTotalPaisa,
      taxPaisa: totalTaxPaisa,
      perMethod: Object.fromEntries(methodEntries),
      taxByMethod: Object.fromEntries(taxByMethod),
    }).catch((err) => {
      logger?.warn?.(
        { err: (err as Error).message, orderId: String(order._id) },
        'pos:order.placed publish failed (non-fatal)',
      );
    });

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
