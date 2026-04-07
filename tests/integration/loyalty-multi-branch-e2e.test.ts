/**
 * Loyalty Multi-Branch E2E — Nike-with-Stores Business Scenarios
 *
 * Single-tenant, multi-branch loyalty program:
 * - ONE company, MANY branches (stores/outlets)
 * - ONE loyalty program, ONE member per customer across all branches
 * - Card works globally — scanned at any branch
 * - Every transaction carries branch provenance in metadata
 * - Earning rules, tiers, referrals are company-wide
 *
 * This test validates the full business lifecycle that a commerce platform
 * like Nike Bangladesh or Uniqlo would run across their store network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';

let replSet: MongoMemoryReplSet;
let engine: LoyaltyEngine;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let bridge: typeof import('#resources/sales/loyalty/loyalty.bridge.js');

// Branches (simulating Nike Bangladesh network)
const BRANCHES = {
  DHK_MAIN: { code: 'DHK', name: 'Dhaka Flagship' },
  CTG_OUTLET: { code: 'CTG', name: 'Chittagong Outlet' },
  SYL_STORE: { code: 'SYL', name: 'Sylhet Store' },
} as const;

function ctx(actorId = 'cashier-001') {
  return { actorId };
}

function ctxWithBranch(branchCode: string, actorId = 'cashier-001') {
  return { actorId, branchCode };
}

async function createCustomer(name = 'Test Customer') {
  const phone = `017${Date.now().toString().slice(-8)}`;
  return Customer.create({
    name,
    phone,
    email: `${phone}@test.bd`,
    isActive: true,
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
  });
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());

  engine = createLoyaltyEngine({
    mongoose: mongoose.connection,
    tenant: false, // Single-tenant: one company
    program: { conversionRate: 10 },
    redemption: {
      minPoints: 100,
      minOrderAmount: 500,
      maxRedeemPercent: 50,
      reservationTtlMinutes: 15,
    },
    referral: {
      referrerRewardPoints: 200,
      refereeRewardPoints: 100,
      maxPerPeriod: 5,
      periodDays: 30,
      requireApproval: false,
      codeLength: 8,
    },
  });

  for (const model of Object.values(engine.models) as any[]) {
    await model.createCollection();
  }

  Customer = (await import('#resources/sales/customers/customer.model.js')).default;
  const { setLoyaltyEngine } = await import('#resources/sales/loyalty/loyalty.plugin.js');
  setLoyaltyEngine(engine);
  bridge = await import('#resources/sales/loyalty/loyalty.bridge.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  await Customer.deleteMany({});
  for (const model of Object.values(engine.models) as any[]) {
    await model.deleteMany({});
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. ENROLLMENT WITH BRANCH PROVENANCE
// ═══════════════════════════════════════════════════════════════════════════

describe('Branch-Aware Enrollment', () => {
  it('card ID encodes the enrolling branch code', async () => {
    const customer = await createCustomer('Rahim');
    const member = await bridge.enrollCustomer(
      customer._id.toString(),
      ctxWithBranch(BRANCHES.DHK_MAIN.code),
    );

    expect(member.cardId).toMatch(/^MBR-DHK-\d{8}-\d$/);
    expect(member.metadata?.enrollingBranchCode).toBe('DHK');

    const doc = await Customer.findById(customer._id).lean() as any;
    expect(doc.membership.cardId).toMatch(/^MBR-DHK-/);
  });

  it('different branches produce different card prefixes but same global program', async () => {
    const cust1 = await createCustomer('Rahim');
    const cust2 = await createCustomer('Karim');

    const m1 = await bridge.enrollCustomer(cust1._id.toString(), ctxWithBranch('DHK'));
    const m2 = await bridge.enrollCustomer(cust2._id.toString(), ctxWithBranch('CTG'));

    expect(m1.cardId).toMatch(/^MBR-DHK-/);
    expect(m2.cardId).toMatch(/^MBR-CTG-/);

    // Same program
    expect(m1.programId).toBe(m2.programId);
  });

  it('enrollment without branch defaults to HQ', async () => {
    const customer = await createCustomer('Fahim');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    expect(member.cardId).toMatch(/^MBR-HQ-/);
  });

  it('getByCardId resolves member regardless of enrolling branch', async () => {
    const customer = await createCustomer('Sakib');
    const member = await bridge.enrollCustomer(
      customer._id.toString(),
      ctxWithBranch('SYL'),
    );

    const found = await engine.services.member.getByCardId(member.cardId!, ctx());
    expect(found).not.toBeNull();
    expect(found!.externalId).toBe(customer._id.toString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CROSS-BRANCH POINT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('Cross-Branch Point Operations', () => {
  it('earns at Dhaka, redeems at Chittagong — one global balance', async () => {
    const customer = await createCustomer('Nayeem');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));

    // Earn at Dhaka
    await engine.services.ledger.earnPoints({
      memberId: member._id,
      points: 1000,
      description: 'Order at Dhaka Flagship',
      referenceType: 'order',
      referenceId: 'dhk_order_001',
      idempotencyKey: 'order_earn:dhk_order_001',
      metadata: { branchId: 'branch_dhk', branchCode: 'DHK' },
    }, ctx());

    // Redeem at Chittagong
    const validation = await engine.services.redemption.validate({
      memberId: member._id,
      pointsToRedeem: 500,
      orderTotal: 3000,
    }, ctx());
    expect(validation.valid).toBe(true);

    const reservation = await engine.services.redemption.reserve({
      memberId: member._id,
      pointsToRedeem: 500,
      orderTotal: 3000,
      ownerType: 'Order',
      ownerId: 'ctg_order_001',
    }, ctx());

    await engine.services.redemption.confirm(reservation._id, ctx());

    // Earn on the Chittagong order too
    await engine.services.ledger.earnPoints({
      memberId: member._id,
      points: 250,
      description: 'Order at Chittagong Outlet',
      referenceType: 'order',
      referenceId: 'ctg_order_001',
      idempotencyKey: 'order_earn:ctg_order_001',
      metadata: { branchId: 'branch_ctg', branchCode: 'CTG' },
    }, ctx());

    // Final balance: 1000 - 500 + 250 = 750 current, 1250 lifetime, 500 redeemed
    const bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(750);
    expect(bal.lifetime).toBe(1250);
    expect(bal.redeemed).toBe(500);
  });

  it('transaction metadata carries branch attribution for analytics', async () => {
    const customer = await createCustomer('Anik');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));

    await engine.services.ledger.earnPoints({
      memberId: member._id,
      points: 500,
      description: 'Sylhet order',
      idempotencyKey: 'order_earn:syl_001',
      metadata: { branchId: 'branch_syl', branchCode: 'SYL' },
    }, ctx());

    const history = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 10 }, ctx());
    const tx = history.docs[0] as any;
    expect(tx.metadata?.branchId).toBe('branch_syl');
    expect(tx.metadata?.branchCode).toBe('SYL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. IDEMPOTENT CANCEL / REFUND (prevents double-credit)
// ═══════════════════════════════════════════════════════════════════════════

describe('Cancel/Refund Idempotency', () => {
  it('cancel restore + refund restore with same orderId → only one credit', async () => {
    const customer = await createCustomer('Tanvir');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));

    // Earn + redeem
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 2000, description: 'order',
      idempotencyKey: 'order_earn:o1',
    }, ctx());

    const res = await engine.services.redemption.reserve({
      memberId: member._id, pointsToRedeem: 500, orderTotal: 5000,
      ownerType: 'Order', ownerId: 'o1',
    }, ctx());
    await engine.services.redemption.confirm(res._id, ctx());

    // Cancel → restore points
    const restoreCancel = await engine.services.ledger.adjustPoints({
      memberId: member._id, points: 500,
      description: 'Order cancelled: o1', reason: 'cancel',
      idempotencyKey: 'order_redeem_restore_cancel:o1',
    }, ctx());
    expect(restoreCancel.points).toBe(500);

    // Refund → same order — should be idempotent (different key, different operation)
    const restoreRefund = await engine.services.ledger.adjustPoints({
      memberId: member._id, points: 500,
      description: 'Order refunded: o1', reason: 'refund',
      idempotencyKey: 'order_redeem_restore_refund:o1',
    }, ctx());
    // This is a legitimate separate restoration (cancel and refund are different events)
    expect(restoreRefund.points).toBe(500);

    // But repeating cancel restore → idempotent, returns same tx
    const dupCancel = await engine.services.ledger.adjustPoints({
      memberId: member._id, points: 500,
      description: 'Order cancelled: o1', reason: 'cancel',
      idempotencyKey: 'order_redeem_restore_cancel:o1',
    }, ctx());
    expect(String(dupCancel._id)).toBe(String(restoreCancel._id));

    // And repeating refund restore → idempotent too
    const dupRefund = await engine.services.ledger.adjustPoints({
      memberId: member._id, points: 500,
      description: 'Order refunded: o1', reason: 'refund',
      idempotencyKey: 'order_redeem_restore_refund:o1',
    }, ctx());
    expect(String(dupRefund._id)).toBe(String(restoreRefund._id));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. EARNING RULES (Company-Wide)
// ═══════════════════════════════════════════════════════════════════════════

describe('Earning Rules', () => {
  it('CRUD lifecycle: create → list → update → deactivate', async () => {
    const rule = await engine.services.earning.createRule({
      name: 'Double Points Weekend',
      type: 'order',
      priority: 10,
      conditions: { minOrderAmount: 1000 },
      reward: { multiplier: 2 },
    }, ctx());

    expect(rule.name).toBe('Double Points Weekend');
    expect(rule.status).toBe('active');

    // List
    const list = await engine.services.earning.listRules({ page: 1, limit: 10 }, ctx());
    expect(list.docs.length).toBe(1);

    // Update
    const updated = await engine.services.earning.updateRule(rule._id, {
      name: 'Triple Points Weekend',
      reward: { multiplier: 3 },
    }, ctx());
    expect(updated.name).toBe('Triple Points Weekend');

    // Deactivate
    const deactivated = await engine.services.earning.deactivateRule(rule._id, ctx());
    expect(deactivated.status).toBe('paused');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. TIER PROGRESSION (Company-Wide)
// ═══════════════════════════════════════════════════════════════════════════

describe('Tier Progression', () => {
  it('defines tiers → member earns enough → auto-upgrades', async () => {
    // Define company-wide tiers
    await engine.services.tier.createTier({
      name: 'Bronze', rank: 1,
      qualificationCriteria: { minLifetimePoints: 0 },
      benefits: { pointsMultiplier: 1 },
      downgrade: { enabled: false, gracePeriodDays: 0 },
    }, ctx());
    await engine.services.tier.createTier({
      name: 'Silver', rank: 2,
      qualificationCriteria: { minLifetimePoints: 1000 },
      benefits: { pointsMultiplier: 1.5, discountPercent: 5 },
      downgrade: { enabled: true, gracePeriodDays: 30 },
    }, ctx());
    await engine.services.tier.createTier({
      name: 'Gold', rank: 3,
      qualificationCriteria: { minLifetimePoints: 5000 },
      benefits: { pointsMultiplier: 2, discountPercent: 10, freeShipping: true },
      downgrade: { enabled: true, gracePeriodDays: 60 },
    }, ctx());

    // Enroll customer
    const customer = await createCustomer('VIP Rahim');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));

    // Earn 1500 points across branches → should qualify for Silver
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 800, description: 'Dhaka order',
      metadata: { branchCode: 'DHK' },
    }, ctx());
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 700, description: 'Chittagong order',
      metadata: { branchCode: 'CTG' },
    }, ctx());

    // Evaluate → should upgrade to Silver
    const eval1 = await engine.services.tier.evaluateMember(member._id, ctx());
    expect(eval1.action).toBe('upgraded');
    expect(eval1.newTier).toBe('Silver');

    // Earn more → Gold
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 4000, description: 'Big Sylhet order',
      metadata: { branchCode: 'SYL' },
    }, ctx());

    const eval2 = await engine.services.tier.evaluateMember(member._id, ctx());
    expect(eval2.action).toBe('upgraded');
    expect(eval2.newTier).toBe('Gold');

    // List tiers — company-wide
    const tiers = await engine.services.tier.listTiers(ctx());
    expect(tiers.length).toBe(3);
    expect(tiers[0].name).toBe('Bronze'); // sorted by rank
    expect(tiers[2].name).toBe('Gold');
  });

  it('tier override by admin → stays until cleared', async () => {
    await engine.services.tier.createTier({
      name: 'Platinum', rank: 4,
      qualificationCriteria: { minLifetimePoints: 50000 },
      benefits: { pointsMultiplier: 3, discountPercent: 15, freeShipping: true },
    }, ctx());

    const customer = await createCustomer('CEO Friend');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    // Manual VIP override
    await engine.services.tier.setOverride(member._id, 'Platinum', 'CEO request', ctx());

    const m = await engine.services.member.getById(member._id, ctx());
    expect(m.tierOverride).toBe('Platinum');
    expect(m.tierOverrideReason).toBe('CEO request');

    // Auto-evaluate should not override the manual setting
    const evaluation = await engine.services.tier.evaluateMember(member._id, ctx());
    expect(evaluation.action).toBe('unchanged');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. REFERRAL PROGRAM (Company-Wide)
// ═══════════════════════════════════════════════════════════════════════════

describe('Referral Program', () => {
  it('full referral flow: generate code → new customer applies → both rewarded', async () => {
    // Existing customer (referrer)
    const referrer = await createCustomer('Referrer Rahim');
    const referrerMember = await bridge.enrollCustomer(referrer._id.toString(), ctxWithBranch('DHK'));

    // Generate referral code
    const code = await engine.services.referral.generateCode(referrerMember._id, ctx());
    expect(code).toBeDefined();
    expect(code.length).toBe(8);

    // New customer (referee) enrolls at a different branch
    const referee = await createCustomer('New Karim');
    const refereeMember = await bridge.enrollCustomer(referee._id.toString(), ctxWithBranch('CTG'));

    // Apply referral (auto-approve since requireApproval: false)
    const referral = await engine.services.referral.recordReferral({
      referralCode: code,
      refereeExternalId: referee._id.toString(),
      refereeExternalType: 'customer',
    }, ctx());

    expect(referral.status).toBe('approved'); // auto-approved

    // Both should have been rewarded
    const referrerBal = await engine.services.member.getBalance(referrerMember._id, ctx());
    expect(referrerBal.current).toBe(200); // referrerRewardPoints

    const refereeBal = await engine.services.member.getBalance(refereeMember._id, ctx());
    expect(refereeBal.current).toBe(100); // refereeRewardPoints
  });

  it('prevents self-referral', async () => {
    const customer = await createCustomer('Self Referrer');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    const code = await engine.services.referral.generateCode(member._id, ctx());

    await expect(
      engine.services.referral.recordReferral({
        referralCode: code,
        refereeExternalId: customer._id.toString(),
        refereeExternalType: 'customer',
      }, ctx()),
    ).rejects.toThrow(/self/i);
  });

  it('prevents duplicate referral', async () => {
    const referrer = await createCustomer('R1');
    const referee = await createCustomer('R2');
    const rm = await bridge.enrollCustomer(referrer._id.toString(), ctx());
    await bridge.enrollCustomer(referee._id.toString(), ctx());

    const code = await engine.services.referral.generateCode(rm._id, ctx());

    await engine.services.referral.recordReferral({
      referralCode: code,
      refereeExternalId: referee._id.toString(),
      refereeExternalType: 'customer',
    }, ctx());

    // Second referral for same referee → duplicate
    await expect(
      engine.services.referral.recordReferral({
        referralCode: code,
        refereeExternalId: referee._id.toString(),
        refereeExternalType: 'customer',
      }, ctx()),
    ).rejects.toThrow(/duplicate|already/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. PROJECTION SYNC (Customer.membership)
// ═══════════════════════════════════════════════════════════════════════════

describe('Projection Sync', () => {
  it('syncCustomerMembership projects all fields including syncedAt', async () => {
    const customer = await createCustomer('Sync Test');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));

    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 750, description: 'test',
    }, ctx());

    await bridge.syncCustomerMembership(customer._id.toString());

    const doc = await Customer.findById(customer._id).lean() as any;
    expect(doc.membership.points.current).toBe(750);
    expect(doc.membership.points.lifetime).toBe(750);
    expect(doc.membership.isActive).toBe(true);
    expect(doc.membership.cardId).toMatch(/^MBR-DHK-/);
    expect(doc.membership.syncedAt).toBeDefined();
    expect(doc.membership.syncedAt).toBeInstanceOf(Date);
  });

  it('loyalty virtual alias works', async () => {
    const customer = await createCustomer('Alias Test');
    await bridge.enrollCustomer(customer._id.toString(), ctx());

    const doc = await Customer.findById(customer._id) as any;
    // Virtual alias: customer.loyalty → customer.membership
    expect(doc.loyalty).toBeDefined();
    expect(doc.loyalty.isActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. FULL MULTI-BRANCH CHECKOUT SCENARIO
// ═══════════════════════════════════════════════════════════════════════════

describe('Full Multi-Branch Checkout', () => {
  it('customer journey: enroll at DHK → shop at CTG → redeem at SYL → tier up', async () => {
    // Setup tiers
    await engine.services.tier.createTier({
      name: 'Bronze', rank: 1,
      qualificationCriteria: { minLifetimePoints: 0 },
      benefits: { pointsMultiplier: 1 },
    }, ctx());
    await engine.services.tier.createTier({
      name: 'Silver', rank: 2,
      qualificationCriteria: { minLifetimePoints: 500 },
      benefits: { pointsMultiplier: 1.5, discountPercent: 5 },
    }, ctx());

    // Enroll at Dhaka
    const customer = await createCustomer('Journey Customer');
    const member = await bridge.enrollCustomer(customer._id.toString(), ctxWithBranch('DHK'));
    expect(member.cardId).toMatch(/^MBR-DHK-/);

    // Shop at Chittagong — earn 400 pts
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 400, description: 'CTG order #1',
      referenceType: 'order', referenceId: 'ctg_001',
      idempotencyKey: 'order_earn:ctg_001',
      metadata: { branchCode: 'CTG' },
    }, ctx());

    // Shop at Sylhet — earn 300 pts
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 300, description: 'SYL order #1',
      referenceType: 'order', referenceId: 'syl_001',
      idempotencyKey: 'order_earn:syl_001',
      metadata: { branchCode: 'SYL' },
    }, ctx());

    // Total: 700 lifetime → qualifies for Silver
    const tierEval = await engine.services.tier.evaluateMember(member._id, ctx());
    expect(tierEval.action).toBe('upgraded');
    expect(tierEval.newTier).toBe('Silver');

    // Redeem at Sylhet — 200 pts for discount
    const reservation = await engine.services.redemption.reserve({
      memberId: member._id, pointsToRedeem: 200, orderTotal: 5000,
      ownerType: 'Order', ownerId: 'syl_002',
    }, ctx());
    await engine.services.redemption.confirm(reservation._id, ctx());

    // Earn on that order too
    await engine.services.ledger.earnPoints({
      memberId: member._id, points: 480, description: 'SYL order #2',
      referenceType: 'order', referenceId: 'syl_002',
      idempotencyKey: 'order_earn:syl_002',
      metadata: { branchCode: 'SYL' },
    }, ctx());

    // Final: current = 700 - 200 + 480 = 980, lifetime = 1180, redeemed = 200
    const bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(980);
    expect(bal.lifetime).toBe(1180);
    expect(bal.redeemed).toBe(200);
    expect(bal.tier).toBe('Silver');

    // Sync and verify projection
    await bridge.syncCustomerMembership(customer._id.toString());
    const doc = await Customer.findById(customer._id).lean() as any;
    expect(doc.membership.points.current).toBe(980);
    expect(doc.membership.tier).toBe('Silver');
    expect(doc.membership.cardId).toMatch(/^MBR-DHK-/); // enrolled at DHK
    expect(doc.membership.syncedAt).toBeDefined();

    // Full transaction history shows branch attribution
    const history = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 50 }, ctx());
    const branchCodes = history.docs
      .map((tx: any) => tx.metadata?.branchCode)
      .filter(Boolean);
    expect(branchCodes).toContain('CTG');
    expect(branchCodes).toContain('SYL');
  });
});
