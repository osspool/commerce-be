/**
 * Subscription billing wiring (T2.7).
 *
 * Acceptance (from ERP_COMPLETENESS):
 *   1. Create subscription with monthly cadence → nextBillingDate set 30d out
 *   2. processBillingDue with no due rows → no transaction
 *   3. Advance clock 31 days → run job → transaction created, billing date
 *      advanced another 30 days
 *   4. Pause action stops billing job from picking it up
 *   5. Resume action restores billing schedule from now
 *   6. Cancel is terminal — billing never resumes
 *
 * Bypasses HTTP — exercises kernel + cron directly. The HTTP routes are
 * typecheck-locked elsewhere; this test pins the actual recurring-billing
 * behavior.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ORG = '5f9d88e7c8b8f3a2c8b3a2c8';

let mongo: MongoMemoryServer;
let processBillingDue: typeof import('../../../src/resources/payments/subscription/cron/process-billing-due.js').processBillingDue;
let subscriptionRepository: typeof import('../../../src/resources/payments/subscription/subscription.engine.js').subscriptionRepository;
let transactionRepository: typeof import('../../../src/resources/payments/subscription/subscription.engine.js').transactionRepository;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  // Boot the revenue engine FIRST so the subscription.engine.ts top-level
  // assertion passes.
  const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
  await ensureRevenueEngine({ connection: mongoose.connection });

  // Now safe to import the be-prod subscription engine + cron.
  ({ processBillingDue } = await import(
    '#resources/payments/subscription/cron/process-billing-due.js'
  ));
  ({ subscriptionRepository, transactionRepository } = await import(
    '#resources/payments/subscription/subscription.engine.js'
  ));
}, 90_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongo?.stop();
}, 30_000);

afterEach(async () => {
  // Each test seeds + asserts on fresh subscription + transaction state.
  // Use the registered Mongoose models so collection naming follows the
  // engine's config rather than guessing the pluralized form.
  const subModel = mongoose.connection.models.RevenueSubscription
    ?? mongoose.connection.models.Subscription;
  const txnModel = mongoose.connection.models.RevenueTransaction
    ?? mongoose.connection.models.Transaction;
  if (subModel) await subModel.deleteMany({});
  if (txnModel) await txnModel.deleteMany({});
});

interface SubDoc {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  status: string;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  renewalCount: number;
}

async function seedSubscription(opts: {
  intervalDays: number;
  nextBillingDate: Date;
  startDate?: Date;
}): Promise<SubDoc> {
  return (await subscriptionRepository.create(
    {
      organizationId: ORG,
      customerId: 'cust-1',
      planKey: 'monthly_basic',
      amount: 9900,
      currency: 'BDT',
      isActive: true,
      status: 'active',
      activatedAt: opts.startDate ?? new Date(),
      startDate: opts.startDate ?? new Date(),
      metadata: {
        nextBillingDate: opts.nextBillingDate,
        intervalDays: opts.intervalDays,
      },
    } as Record<string, unknown>,
    { organizationId: ORG },
  )) as unknown as SubDoc;
}

async function reload(id: mongoose.Types.ObjectId): Promise<SubDoc> {
  const doc = await subscriptionRepository.getByQuery(
    { _id: id },
    { organizationId: ORG, throwOnNotFound: false, lean: true },
  );
  return doc as unknown as SubDoc;
}

async function countTransactions(): Promise<number> {
  const txnModel = mongoose.connection.models.RevenueTransaction
    ?? mongoose.connection.models.Transaction;
  if (!txnModel) return 0;
  return txnModel.countDocuments({});
}

describe('Subscription billing (T2.7)', () => {
  it('skips subscriptions whose nextBillingDate is in the future', async () => {
    const future = new Date(Date.now() + 30 * MS_PER_DAY);
    await seedSubscription({ intervalDays: 30, nextBillingDate: future });

    const result = await processBillingDue();
    expect(result.candidates).toBe(0);
    expect(result.billed).toBe(0);
    expect(await countTransactions()).toBe(0);
  });

  it('bills + advances nextBillingDate when due', async () => {
    const startDate = new Date('2026-04-01T00:00:00Z');
    const firstBill = new Date('2026-05-01T00:00:00Z');
    const sub = await seedSubscription({
      intervalDays: 30,
      nextBillingDate: firstBill,
      startDate,
    });

    // Run billing 1 day after the due date
    const tickAt = new Date('2026-05-02T00:00:00Z');
    const result = await processBillingDue(tickAt);

    expect(result.candidates).toBe(1);
    expect(result.billed).toBe(1);
    expect(result.failed).toBe(0);
    expect(await countTransactions()).toBe(1);

    const reloaded = await reload(sub._id);
    expect(reloaded.renewalCount).toBe(1);
    const newNext = new Date(reloaded.metadata!.nextBillingDate as string);
    // Advanced exactly 30 days from the original billed date
    expect(newNext.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('idempotent — re-running the tick at the same instant does not double-bill', async () => {
    const firstBill = new Date('2026-05-01T00:00:00Z');
    await seedSubscription({ intervalDays: 30, nextBillingDate: firstBill });

    const tickAt = new Date('2026-05-02T00:00:00Z');
    const r1 = await processBillingDue(tickAt);
    const r2 = await processBillingDue(tickAt); // fires again — sub now has next due 2026-05-31

    expect(r1.billed).toBe(1);
    // After r1 the next due is 30 days out, so r2 finds nothing
    expect(r2.candidates).toBe(0);
    expect(await countTransactions()).toBe(1);
  });

  it('paused subscriptions are not picked up by the billing tick', async () => {
    const due = new Date('2026-05-01T00:00:00Z');
    const sub = await seedSubscription({ intervalDays: 30, nextBillingDate: due });

    await subscriptionRepository.pause(
      String(sub._id),
      { reason: 'on hold' },
      { organizationId: ORG, actorRef: 'test', actorKind: 'user', correlationId: '' } as never,
    );

    const r = await processBillingDue(new Date('2026-05-02T00:00:00Z'));
    expect(r.candidates).toBe(0);
    expect(r.billed).toBe(0);
    expect(await countTransactions()).toBe(0);
  });

  it('cancelled subscriptions stay terminal — billing never resumes', async () => {
    const due = new Date('2026-05-01T00:00:00Z');
    const sub = await seedSubscription({ intervalDays: 30, nextBillingDate: due });

    await subscriptionRepository.cancel(
      String(sub._id),
      { immediate: true, reason: 'customer churn' },
      { organizationId: ORG, actorRef: 'test', actorKind: 'user', correlationId: '' } as never,
    );

    const r = await processBillingDue(new Date('2026-05-02T00:00:00Z'));
    expect(r.candidates).toBe(0);
    expect(r.billed).toBe(0);

    const reloaded = await reload(sub._id);
    expect(reloaded.isActive).toBe(false);
  });

  it('skips rows with malformed metadata (missing intervalDays)', async () => {
    // Bypass the host create handler and stuff a row directly to simulate
    // legacy / external data.
    const due = new Date('2026-05-01T00:00:00Z');
    await subscriptionRepository.create(
      {
        organizationId: ORG,
        customerId: 'cust-bad',
        planKey: 'broken',
        amount: 100,
        currency: 'BDT',
        isActive: true,
        status: 'active',
        activatedAt: new Date(),
        metadata: { nextBillingDate: due }, // no intervalDays
      } as Record<string, unknown>,
      { organizationId: ORG },
    );

    const r = await processBillingDue(new Date('2026-05-02T00:00:00Z'));
    expect(r.candidates).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.billed).toBe(0);
    expect(await countTransactions()).toBe(0);
  });
});
