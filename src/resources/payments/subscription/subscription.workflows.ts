/**
 * Subscription Workflows — durable background jobs via @classytic/streamline.
 *
 * Replaces the prior `subscription.billing.due` cron with a streamline-driven
 * recurring workflow. The shape mirrors `invoice.workflows.ts`'s dunning
 * pattern (process → sleep → goto process) so we get the same crash-recovery
 * + retry semantics for free.
 *
 * Auto-started at boot via `subscription.bootstrap.ts` with a fixed
 * idempotency key so a multi-pod deploy doesn't fan out N parallel sweeps —
 * streamline's `findActiveByIdempotencyKey` returns the existing run for
 * every replica after the first, and the smart scheduler claims the run
 * exactly once per cycle (race-safe `findOneAndUpdate` claim).
 *
 * `processBillingDue` stays unchanged — it's still the underlying handler
 * that finds due subscriptions, creates revenue transactions with
 * idempotency keys, and advances `nextBillingDate`. The workflow is the
 * orchestration shell around it.
 */

import { createWorkflow, type StreamlineContainer } from '@classytic/streamline';
import logger from '#lib/utils/logger.js';
import { processBillingDue } from './cron/process-billing-due.js';

interface SubscriptionWorkflowInput {
  organizationId?: string;
  actorId?: string;
}

/** Sweep cadence — matches the prior cron's `ONE_HOUR` interval. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Stable idempotency key for the singleton sweep run. Reused at boot
 * across replicas — streamline returns the existing active run instead
 * of starting a parallel one.
 */
export const SUBSCRIPTION_BILLING_SWEEP_KEY = 'subscription-billing-sweep:singleton';

// biome-ignore lint/suspicious/noExplicitAny: createWorkflow return type is heavily generic; plugin collects them as `any[]`
export function createSubscriptionWorkflows(container: StreamlineContainer): any[] {
  // ── Billing sweep ──────────────────────────────────────────────────────────
  // Periodically scans active subscriptions whose `nextBillingDate <= now`,
  // creates pending revenue transactions, advances the schedule. Runs as
  // a self-rescheduling loop so the streamline scheduler — not a process-
  // local setInterval — drives the cadence. Survives process restarts via
  // the persisted `wait` sleep checkpoint.
  const billingSweep = createWorkflow<SubscriptionWorkflowInput>('subscription-billing-sweep', {
    container,
    steps: {
      sweep: {
        handler: async () => {
          const result = await processBillingDue();
          // Only log when there's signal — every-hour ticks against an
          // empty queue would just be noise.
          if (result.billed > 0 || result.failed > 0) {
            logger.info(result, '[subscription] billing sweep');
          }
          return result;
        },
        // The handler already swallows per-subscription failures; the only
        // thing that bubbles up here is infra-level (Mongo down, revenue
        // engine not ready). Three retries with the engine's default
        // backoff covers transient blips without spamming errors.
        retries: 3,
      },
      wait: {
        handler: async (ctx) => {
          await ctx.sleep(SWEEP_INTERVAL_MS);
          await ctx.goto('sweep');
        },
      },
    },
  });

  return [billingSweep];
}
