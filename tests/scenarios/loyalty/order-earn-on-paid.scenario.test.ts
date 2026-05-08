/**
 * Order → Earn-on-paid scenario test.
 *
 * Verifies the canonical promise of the loyalty integration: when an order's
 * payment is confirmed, the enrolled customer's balance increases by the
 * tier-multiplied points the platform config yields.
 *
 * Strategy: boot the real loyalty engine on MongoMemoryReplSet (the kernel
 * needs transactions), seed PlatformConfig.membership, enroll a customer,
 * and drive `wireOrderLoyaltyHook` with a stub OrderEngine whose `on()`
 * captures the listener so the test can invoke it with a synthetic payload.
 * That's the same payload `confirmPayment` would emit; we don't need to boot
 * the full order engine + bridges to prove the hook contract.
 *
 * Three contracts pinned here:
 *   1. Enrolled + paid + config enabled → balance increases by tier-adjusted points.
 *   2. Same after:update fired twice (re-publish, retry) → balance unchanged
 *      (idempotency via earnPoints idempotencyKey="order:<orderId>").
 *   3. Not enrolled → no points credited, no error.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';
import type { OrderEngine } from '@classytic/order';
import { wireOrderLoyaltyHook } from '#resources/sales/orders/order-loyalty-hook.js';

const ACTOR = 'test-system';

let replSet: MongoMemoryReplSet;
let loyaltyEngine: LoyaltyEngine;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let bridge: typeof import('#resources/sales/loyalty/loyalty.bridge.js');
let PlatformConfig: typeof import('#resources/platform/platform.model.js').default;
let platformRepository: typeof import('#resources/platform/platform.repository.js').default;

type AfterUpdateListener = (payload: unknown) => Promise<void> | void;

// Single global trigger captured by `wireOrderLoyaltyHook`. The hook uses a
// module-level `wired` flag (intentional for production hot-reload safety),
// so we wire ONCE for the whole file and route every test's payload through
// this captured listener.
let triggerHook: AfterUpdateListener;

async function createCustomer() {
  const phone = `017${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 100)}`;
  return Customer.create({
    name: { given: 'Earn', family: 'Test' },
    contact: { phone, email: `${phone}@test.example` },
    isActive: true,
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
  });
}

function buildPaidOrderPayload(args: {
  orderId: string;
  customerId: string | null;
  /** BDT-major amount (e.g. 2000 = ৳2000). Converted to paisa here. */
  grandTotal: number;
  chargeStatus?: string;
}) {
  return {
    result: {
      _id: args.orderId,
      orderNumber: `ORD-${args.orderId.slice(-6)}`,
      organizationId: 'branch-1',
      // Bridge reads flat `customerId` (see order-loyalty-hook.ts:
      // `const customerId = order.customerId`). Earlier shape was
      // `customer: { _id }`; that's been retired in favor of the flat
      // field that matches the order kernel's persistence shape.
      customerId: args.customerId ?? undefined,
      // Order kernel persists grandTotal in PAISA (integer minor units).
      // Bridge divides by 100 to get BDT for earning-rule evaluation
      // (`amountPerPoint: 100` = "1 point per ৳100"). Multiply caller's
      // BDT-major figure by 100 here so the production code sees the
      // shape it expects.
      totals: { grandTotal: { amount: args.grandTotal * 100, currency: 'BDT' } },
      paymentState: { chargeStatus: args.chargeStatus ?? 'full' },
    },
    context: { actorRef: ACTOR },
  };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());

  loyaltyEngine = createLoyaltyEngine({
    mongoose: mongoose.connection,
    tenant: false,
    program: { conversionRate: 10 },
    redemption: {
      minPoints: 0,
      minOrderAmount: 0,
      maxRedeemPercent: 50,
      reservationTtlMinutes: 15,
    },
  });

  for (const model of Object.values(loyaltyEngine.models) as Array<{ createCollection: () => Promise<unknown> }>) {
    await model.createCollection();
  }

  Customer = (await import('#resources/sales/customers/customer.model.js')).default;
  PlatformConfig = (await import('#resources/platform/platform.model.js')).default;
  platformRepository = (await import('#resources/platform/platform.repository.js')).default;

  const { setLoyaltyEngine } = await import('#resources/sales/loyalty/loyalty.plugin.js');
  setLoyaltyEngine(loyaltyEngine);

  bridge = await import('#resources/sales/loyalty/loyalty.bridge.js');

  // Wire the hook against a stub OrderEngine that captures the
  // after:findOneAndUpdate listener (the paid-later path — confirmPayment
  // → updatePaymentState routes through findOneAndUpdate and Mongokit
  // emits this event, NOT after:update). The module-level `wired` flag
  // keeps subsequent calls no-ops, so one wiring covers every test.
  let captured: AfterUpdateListener | null = null;
  const stubEngine = {
    repositories: {
      order: {
        on: (event: string, cb: AfterUpdateListener) => {
          if (event === 'after:findOneAndUpdate') captured = cb;
        },
      },
    },
  } as unknown as OrderEngine;
  wireOrderLoyaltyHook(stubEngine);

  if (!captured) throw new Error('wireOrderLoyaltyHook did not register an after:findOneAndUpdate listener');
  triggerHook = captured;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  await Customer.deleteMany({});
  await PlatformConfig.deleteMany({});
  for (const model of Object.values(loyaltyEngine.models) as Array<{ deleteMany: (q: object) => Promise<unknown> }>) {
    await model.deleteMany({});
  }
  // Wipe the platform repo's in-memory cache — getConfig caches with a 5min
  // TTL, so doc-level deleteMany alone leaves a stale entry that future
  // tests would read. Direct invalidation keeps each test on a clean slate.
  const repoWithCache = platformRepository as unknown as { invalidateAllCache?: () => Promise<void> };
  if (typeof repoWithCache.invalidateAllCache === 'function') {
    await repoWithCache.invalidateAllCache();
  }

  // Seed enabled membership config — Bronze 1x, Silver 1.5x, Gold 2x.
  await PlatformConfig.create({
    isSingleton: true,
    membership: {
      enabled: true,
      pointsPerAmount: 1,
      amountPerPoint: 100,
      roundingMode: 'floor',
      tiers: [
        { name: 'Bronze', minPoints: 0, pointsMultiplier: 1 },
        { name: 'Silver', minPoints: 100, pointsMultiplier: 1.5 },
        { name: 'Gold', minPoints: 500, pointsMultiplier: 2 },
      ],
      cardPrefix: 'TST',
      cardDigits: 8,
    },
  });

  // Seed the order-type earning rule the new bridge reads via
  // `engine.repositories.earningRule.getAll`. The loyalty surface
  // switched from a config-driven calculator (read amountPerPoint /
  // pointsPerAmount straight off PlatformConfig.membership) to engine
  // earning-rules — `previewPointsForOrder` filters to active rules
  // matching the member's `programId`. The repository auto-injects
  // `programId` from the resolved config when not supplied (per
  // EarningRuleRepository docstring), so we don't need to know the id
  // ahead of time. Tier multipliers still come from PlatformConfig
  // (the bridge stamps the tier on the member at enrollment time).
  await loyaltyEngine.repositories.earningRule.create({
    name: 'Standard order earn (Bronze 1×, Silver 1.5×, Gold 2×)',
    type: 'order',
    priority: 100,
    conditions: {},
    reward: { amountPerPoint: 100, roundingMode: 'floor' },
  });
});

describe('Order → Earn on paid', () => {
  it('credits tier-multiplied points to an enrolled customer when chargeStatus → full', async () => {
    const customer = await createCustomer();
    const customerId = customer._id.toString();
    await bridge.enrollCustomer(customerId, { actorId: ACTOR, branchCode: 'TST' });

    const orderId = new mongoose.Types.ObjectId().toString();
    await triggerHook(
      buildPaidOrderPayload({ orderId, customerId, grandTotal: 2000 }),
    );

    const member = await bridge.getMemberForCustomer(customerId, { actorId: ACTOR });
    expect(member).toBeTruthy();
    // 2000 / 100 * 1 (Bronze) = 20 points
    expect(member!.balance.current).toBe(20);
    expect(member!.balance.lifetime).toBe(20);

    const refreshed = await Customer.findById(customerId).lean();
    expect((refreshed as { membership?: { points?: { current?: number } } }).membership?.points?.current).toBe(20);
  });

  it('is idempotent — re-firing after:update for the same order does not double-credit', async () => {
    const customer = await createCustomer();
    const customerId = customer._id.toString();
    await bridge.enrollCustomer(customerId, { actorId: ACTOR, branchCode: 'TST' });

    const orderId = new mongoose.Types.ObjectId().toString();
    const payload = buildPaidOrderPayload({ orderId, customerId, grandTotal: 1500 });

    await triggerHook(payload);
    await triggerHook(payload);
    await triggerHook(payload);

    const member = await bridge.getMemberForCustomer(customerId, { actorId: ACTOR });
    // 1500/100 * 1 = 15 points, regardless of how many times the event re-fires.
    expect(member!.balance.current).toBe(15);
    expect(member!.balance.lifetime).toBe(15);
  });

  it('auto-enrolls and credits when the customer was not previously a loyalty member', async () => {
    // Bridge contract changed (order-loyalty-hook.ts:96-109): the paid-
    // order hook now auto-enrolls when no member is found, so every
    // first-paid-order customer earns from order #1. The earlier "no-op"
    // contract is gone — there's no opt-out switch in production code.
    // Test the new contract: a customer with no prior member record
    // earns points after their first paid order.
    const customer = await createCustomer();
    const customerId = customer._id.toString();

    await triggerHook(
      buildPaidOrderPayload({
        orderId: new mongoose.Types.ObjectId().toString(),
        customerId,
        grandTotal: 5000,
      }),
    );

    const member = await bridge.getMemberForCustomer(customerId, { actorId: ACTOR });
    expect(member).toBeTruthy();
    // 5000/100 * 1 (Bronze) = 50
    expect(member!.balance.current).toBe(50);
  });

  it('is a no-op for guest orders (no customer attached)', async () => {
    // Should not throw.
    await triggerHook(
      buildPaidOrderPayload({
        orderId: new mongoose.Types.ObjectId().toString(),
        customerId: null,
        grandTotal: 5000,
      }),
    );

    // Nothing to assert on the loyalty side — no member exists. The contract
    // is "doesn't blow up on guest orders".
    expect(true).toBe(true);
  });

  it('skips when chargeStatus is not "full" (partial captures stay dark)', async () => {
    const customer = await createCustomer();
    const customerId = customer._id.toString();
    await bridge.enrollCustomer(customerId, { actorId: ACTOR, branchCode: 'TST' });

    await triggerHook(
      buildPaidOrderPayload({
        orderId: new mongoose.Types.ObjectId().toString(),
        customerId,
        grandTotal: 2000,
        chargeStatus: 'partial',
      }),
    );

    const member = await bridge.getMemberForCustomer(customerId, { actorId: ACTOR });
    expect(member!.balance.current).toBe(0);
  });

  it('skips when membership is disabled in PlatformConfig', async () => {
    await PlatformConfig.findOneAndUpdate(
      { isSingleton: true },
      { $set: { 'membership.enabled': false } },
    );
    // Direct doc update bypasses the platform repo cache → invalidate so the
    // hook reads the disabled flag instead of the cached enabled config.
    const repoWithCache = platformRepository as unknown as { invalidateAllCache?: () => Promise<void> };
    if (typeof repoWithCache.invalidateAllCache === 'function') {
      await repoWithCache.invalidateAllCache();
    }

    const customer = await createCustomer();
    const customerId = customer._id.toString();
    await bridge.enrollCustomer(customerId, { actorId: ACTOR, branchCode: 'TST' });

    await triggerHook(
      buildPaidOrderPayload({
        orderId: new mongoose.Types.ObjectId().toString(),
        customerId,
        grandTotal: 2000,
      }),
    );

    const member = await bridge.getMemberForCustomer(customerId, { actorId: ACTOR });
    expect(member!.balance.current).toBe(0);
  });
});
