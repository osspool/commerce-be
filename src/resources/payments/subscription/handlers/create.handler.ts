import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getContextFromReq } from '#shared/context.js';
import { subscriptionRepository } from '../subscription.engine.js';
import { createSubscriptionSchema } from '../schemas/subscription.schemas.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type CreateBody = z.infer<typeof createSubscriptionSchema.body>;

/**
 * Repo-driven create. The kernel's create accepts the FSM fields; the
 * host stamps `metadata.nextBillingDate` and `metadata.intervalDays` so
 * the cron's billing sweeper has a stable schedule to read.
 *
 * Default flow: subscriptions land in `pending` (kernel default) and an
 * admin / payment provider activates them later via the `activate`
 * action (or the kernel's repo verb). For T2.7 simplicity we
 * auto-activate on create — most B2B/SaaS flows assume "create a
 * subscription = it's live", with payment failures handled by the
 * billing cron.
 */
export async function createSubscriptionHandler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = getContextFromReq(req);
  const body = req.body as CreateBody;

  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  const nextBillingDate = body.nextBillingDate
    ? new Date(body.nextBillingDate)
    : new Date(startDate.getTime() + body.intervalDays * MS_PER_DAY);

  const created = await subscriptionRepository.create(
    {
      organizationId: ctx.organizationId,
      customerId: body.customerId,
      planKey: body.planKey,
      amount: body.amount,
      currency: body.currency,
      startDate,
      isActive: true,
      status: 'active',
      activatedAt: startDate,
      metadata: {
        ...(body.metadata ?? {}),
        nextBillingDate,
        intervalDays: body.intervalDays,
      },
    } as Record<string, unknown>,
    { organizationId: ctx.organizationId },
  );

  return reply.status(201).send(created);
}
