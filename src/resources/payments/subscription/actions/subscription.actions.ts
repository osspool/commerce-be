import type { RequestWithExtras } from '@classytic/arc/types';
import permissions from '#config/permissions.js';
import { getContextFromReq } from '#shared/context.js';
import { subscriptionRepository } from '../subscription.engine.js';
import {
  cancelSubscriptionSchema,
  pauseSubscriptionSchema,
  resumeSubscriptionSchema,
} from '../schemas/subscription.schemas.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function rethrowKernelError(
  err: unknown,
  codeToStatus: Record<string, number>,
  fallback: string,
): never {
  const e = err as { code?: string; message?: string };
  const status = e?.code ? codeToStatus[e.code] : undefined;
  if (status) {
    throw Object.assign(new Error(e.message ?? fallback), {
      statusCode: status,
      code: e.code,
    });
  }
  throw err;
}

/**
 * Read `metadata.intervalDays` off a subscription doc — the host-side
 * billing cadence. Returns `null` if missing.
 */
function readIntervalDays(doc: { metadata?: Record<string, unknown> | null }): number | null {
  const v = doc.metadata?.intervalDays;
  return typeof v === 'number' && v > 0 ? v : null;
}

export const subscriptionActions = {
  pause: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      try {
        return await subscriptionRepository.pause(
          id,
          { reason: (data.reason as string) ?? 'paused' },
          getContextFromReq(req) as unknown as Parameters<typeof subscriptionRepository.pause>[2],
        );
      } catch (err) {
        rethrowKernelError(
          err,
          {
            SUBSCRIPTION_NOT_FOUND: 404,
            INVALID_STATE_TRANSITION: 422,
          },
          'Cannot pause subscription',
        );
      }
    },
    schema: pauseSubscriptionSchema,
    permissions: permissions.transactions.update,
  },

  /**
   * Resume the subscription. By default `extendPeriod=false` here — billing
   * picks up from "now + intervalDays" rather than honouring the original
   * (now-stale) `nextBillingDate`. Pass `extendPeriod: true` to keep the
   * original cadence and treat the paused window as bonus time.
   */
  resume: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      try {
        const resumed = await subscriptionRepository.resume(
          id,
          { extendPeriod: Boolean(data.extendPeriod) },
          ctx as unknown as Parameters<typeof subscriptionRepository.resume>[2],
        );
        // Re-anchor next billing relative to NOW unless caller explicitly
        // asked to extend. Without this, a 14-day pause leaves the
        // subscription in a "billing was due 14 days ago" state and the
        // cron fires immediately — surprising for ops.
        if (!data.extendPeriod) {
          const interval = readIntervalDays(resumed);
          if (interval !== null) {
            const newNext = new Date(Date.now() + interval * MS_PER_DAY);
            await subscriptionRepository.update(
              String(resumed._id),
              { 'metadata.nextBillingDate': newNext } as Record<string, unknown>,
              { organizationId: ctx.organizationId, lean: true },
            );
            // Reflect the update on the returned doc without a re-fetch.
            (resumed.metadata as Record<string, unknown>).nextBillingDate = newNext;
          }
        }
        return resumed;
      } catch (err) {
        rethrowKernelError(
          err,
          {
            SUBSCRIPTION_NOT_FOUND: 404,
            INVALID_STATE_TRANSITION: 422,
          },
          'Cannot resume subscription',
        );
      }
    },
    schema: resumeSubscriptionSchema,
    permissions: permissions.transactions.update,
  },

  cancel: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const ctx = getContextFromReq(req);
      try {
        return await subscriptionRepository.cancel(
          id,
          {
            immediate: Boolean(data.immediate),
            ...(data.reason ? { reason: data.reason as string } : {}),
          },
          ctx as unknown as Parameters<typeof subscriptionRepository.cancel>[2],
        );
      } catch (err) {
        rethrowKernelError(
          err,
          {
            SUBSCRIPTION_NOT_FOUND: 404,
            INVALID_STATE_TRANSITION: 422,
          },
          'Cannot cancel subscription',
        );
      }
    },
    schema: cancelSubscriptionSchema,
    permissions: permissions.transactions.update,
  },
};
