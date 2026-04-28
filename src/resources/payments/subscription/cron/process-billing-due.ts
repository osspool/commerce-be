/**
 * Subscription billing tick — finds active subscriptions whose
 * `metadata.nextBillingDate <= now`, creates a `revenue.transaction`
 * record (`flow: 'inflow'`, `type: 'subscription'`), and advances the
 * `nextBillingDate` by `metadata.intervalDays`.
 *
 * Idempotency: each transaction's `idempotencyKey` is
 * `subscription:${publicId}:${nextBillingDate.toISOString()}`. If the
 * job re-runs between the transaction-create and the billing-date
 * advance (e.g. crashed mid-tick), the second run hits the unique-index
 * dedup in revenue's transaction repo — no duplicate charge.
 *
 * Per-subscription failures are logged and don't stop the sweep —
 * one bad row never blocks the rest of the queue.
 */
import logger from '#lib/utils/logger.js';
import { isRevenueReady } from '#shared/revenue/engine.js';
import {
  subscriptionRepository,
  transactionRepository,
} from '../subscription.engine.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface BillingDueResult {
  /** Subscriptions whose nextBillingDate was <= now. */
  candidates: number;
  /** Successful billing transactions created. */
  billed: number;
  /** Subscriptions skipped (no intervalDays, missing fields, etc.). */
  skipped: number;
  /** Subscriptions whose tick threw — logged + counted, never rethrown. */
  failed: number;
}

interface BillableSubscription {
  _id: { toString(): string };
  publicId?: string;
  organizationId?: string;
  customerId?: string;
  amount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One pass over due subscriptions. Returns counts for observability —
 * cron registry logs them when non-zero.
 */
export async function processBillingDue(now: Date = new Date()): Promise<BillingDueResult> {
  const result: BillingDueResult = { candidates: 0, billed: 0, skipped: 0, failed: 0 };
  if (!isRevenueReady()) return result;

  // Active + isActive guards both required: kernel FSM transitions a
  // paused/cancelled doc through `status` AND `isActive` — filtering on
  // both sidesteps any race where one is updated before the other.
  const candidates = (await subscriptionRepository.findAll(
    {
      status: 'active',
      isActive: true,
      'metadata.nextBillingDate': { $lte: now },
    },
    { lean: true } as Record<string, unknown>,
  )) as unknown as BillableSubscription[];

  result.candidates = candidates.length;

  for (const sub of candidates) {
    const intervalDays = sub.metadata?.intervalDays;
    const nextBillingDate = sub.metadata?.nextBillingDate;
    if (typeof intervalDays !== 'number' || intervalDays <= 0 || !nextBillingDate) {
      result.skipped++;
      continue;
    }

    const billedAt = new Date(nextBillingDate as string);
    const idempotencyKey = `subscription:${String(sub.publicId ?? sub._id)}:${billedAt.toISOString()}`;

    try {
      await transactionRepository.create(
        {
          ...(sub.organizationId ? { organizationId: sub.organizationId } : {}),
          ...(sub.customerId ? { customerId: sub.customerId } : {}),
          type: 'subscription',
          method: 'subscription',
          amount: sub.amount,
          currency: sub.currency ?? 'BDT',
          status: 'pending',
          flow: 'inflow',
          sourceId: String(sub._id),
          sourceModel: 'RevenueSubscription',
          idempotencyKey,
          metadata: {
            subscriptionPublicId: sub.publicId,
            billedFor: billedAt.toISOString(),
          },
        } as Record<string, unknown>,
        sub.organizationId
          ? ({ organizationId: sub.organizationId } as Record<string, unknown>)
          : undefined,
      );

      // Advance schedule one cycle. Atomic — separate from the
      // transaction create so a transaction-create dedup hit (re-run
      // after a partial failure) still pushes the date forward.
      const newNext = new Date(billedAt.getTime() + intervalDays * MS_PER_DAY);
      await subscriptionRepository.update(
        String(sub._id),
        {
          'metadata.nextBillingDate': newNext,
          $inc: { renewalCount: 1 },
        } as Record<string, unknown>,
        sub.organizationId
          ? ({ organizationId: sub.organizationId, lean: true } as Record<string, unknown>)
          : ({ lean: true } as Record<string, unknown>),
      );

      result.billed++;
    } catch (err) {
      result.failed++;
      logger.error(
        { err: (err as Error).message, subscriptionId: String(sub._id) },
        '[subscription] billing tick failed',
      );
    }
  }

  return result;
}
