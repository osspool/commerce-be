import { z } from 'zod';

/**
 * Body shape for `POST /subscriptions`. The kernel's
 * `SubscriptionCreateInput` doesn't carry a billing cadence (the kernel
 * is FSM-only), so the host adds `intervalDays` here and stamps
 * `metadata.nextBillingDate` / `metadata.intervalDays` on create.
 */
export const createSubscriptionSchema = {
  body: z.object({
    customerId: z.string().min(1),
    planKey: z.string().min(1),
    amount: z.number().nonnegative(),
    currency: z.string().min(3).max(3).default('BDT'),
    /** Days between billing events. 30 = monthly, 365 = yearly. */
    intervalDays: z.number().int().positive(),
    /** When the first billing should fire. Defaults to `startDate + intervalDays`. */
    nextBillingDate: z.iso.datetime().optional(),
    startDate: z.iso.datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
  }),
};

export const pauseSubscriptionSchema = z.object({
  reason: z.string().optional(),
});

export const resumeSubscriptionSchema = z.object({
  /**
   * When true (kernel default), the billing schedule is extended by the
   * paused duration. When false, billing resumes from now (skip the
   * paused window entirely). Default `false` here — most ops pull
   * "resume from today" semantics.
   */
  extendPeriod: z.boolean().optional(),
});

export const cancelSubscriptionSchema = z.object({
  /** When true, cancel takes effect immediately (no grace period). */
  immediate: z.boolean().optional(),
  reason: z.string().optional(),
});
