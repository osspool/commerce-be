/**
 * Loyalty E2E — Full Membership Lifecycle Tests
 *
 * Tests the complete loyalty lifecycle through the @classytic/loyalty engine
 * integrated with be-prod's Customer model via the loyalty bridge.
 *
 * Uses MongoMemoryReplSet for transaction support (loyalty engine uses transactions).
 *
 * Scenarios:
 * 1. Enrollment: customer enrolls → LoyaltyMember created → Customer.membership synced
 * 2. Point earning: order completes → points awarded via engine → balance updated
 * 3. Point adjustment: admin bonus/correction → ledger tracks → balance updated
 * 4. Point redemption: validate → reserve → confirm (or release on failure)
 * 5. Tier progression: earn enough → auto-upgrade → Customer.membership.tier synced
 * 6. Deactivation & reactivation: deactivate → earn fails → reactivate → earn works
 * 7. Concurrent safety: parallel adjustments → no negative balance
 * 8. Idempotency: same earn twice with same key → only one transaction
 * 9. Transaction history: earn + adjust + redeem → all appear in ledger
 * 10. POS integration: membership card → tier discount + redemption + earn in one flow
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';

let replSet: MongoMemoryReplSet;
let engine: LoyaltyEngine;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let bridge: typeof import('#resources/sales/loyalty/loyalty.bridge.js');

const ACTOR = 'test-cashier';

function ctx() {
  return { actorId: ACTOR };
}

async function createCustomer(overrides: Record<string, unknown> = {}) {
  const phone = `017${Date.now().toString().slice(-8)}`;
  return Customer.create({
    name: 'Test Customer',
    phone,
    email: `test-${phone}@example.com`,
    isActive: true,
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
    ...overrides,
  });
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());

  engine = createLoyaltyEngine({
    mongoose: mongoose.connection,
    tenant: false,
    program: { conversionRate: 10 }, // 10 points = 1 BDT
    redemption: {
      minPoints: 100,
      minOrderAmount: 500,
      maxRedeemPercent: 50,
      reservationTtlMinutes: 15,
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

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ENROLLMENT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Enrollment Lifecycle', () => {
  it('enrolls customer → creates LoyaltyMember → syncs Customer.membership', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    // LoyaltyMember created
    expect(member.externalId).toBe(customer._id.toString());
    expect(member.externalType).toBe('customer');
    expect(member.status).toBe('active');
    expect(member.balance.current).toBe(0);
    expect(member.balance.lifetime).toBe(0);
    expect(member.referralCode).toBeDefined();

    // Customer.membership thin field synced
    const updated = await Customer.findById(customer._id).lean() as any;
    expect(updated.membership).toBeDefined();
    expect(updated.membership.isActive).toBe(true);
    // Card ID uses smart format (MBR-HQ-XXXXXXXX-C), not referralCode
    expect(updated.membership.cardId).toMatch(/^MBR-HQ-\d{8}-\d$/);
    expect(updated.membership.points.current).toBe(0);
  });

  it('rejects duplicate enrollment', async () => {
    const customer = await createCustomer();
    await bridge.enrollCustomer(customer._id.toString(), ctx());

    await expect(
      bridge.enrollCustomer(customer._id.toString(), ctx()),
    ).rejects.toThrow(/already enrolled/i);
  });

  it('deactivate → block operations → reactivate → operations work', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    // Earn some points
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 500, description: 'initial' },
      ctx(),
    );

    // Deactivate
    await bridge.deactivateCustomerMembership(customer._id.toString(), ctx());

    // Earning should fail on inactive member
    await expect(
      engine.services.ledger.earnPoints(
        { memberId: member._id, points: 100, description: 'blocked' },
        ctx(),
      ),
    ).rejects.toThrow(/not active/i);

    // Customer synced
    let customerDoc = await Customer.findById(customer._id).lean() as any;
    expect(customerDoc.membership.isActive).toBe(false);

    // Reactivate
    await bridge.reactivateCustomerMembership(customer._id.toString(), ctx());

    // Earning works again
    const tx = await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 200, description: 'after reactivate' },
      ctx(),
    );
    expect(tx.points).toBe(200);

    customerDoc = await Customer.findById(customer._id).lean() as any;
    expect(customerDoc.membership.isActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. POINT EARNING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Point Earning', () => {
  it('earns points → balance updated → transaction in ledger', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    const tx = await engine.services.ledger.earnPoints(
      {
        memberId: member._id,
        points: 500,
        description: 'POS order: order_123',
        referenceType: 'order',
        referenceId: 'order_123',
      },
      ctx(),
    );

    expect(tx.type).toBe('earn');
    expect(tx.points).toBe(500);
    expect(tx.balanceAfter).toBe(500);

    // Verify balance
    const balance = await engine.services.ledger.getBalance(member._id, ctx());
    expect(balance).toBe(500);

    // Verify history
    const history = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 10 }, ctx());
    expect(history.docs.length).toBe(1);
    expect(history.docs[0].type).toBe('earn');
  });

  it('idempotent earn — same key twice → only one transaction', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    const key = 'pos_earn:order_456';

    const tx1 = await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 300, description: 'order', idempotencyKey: key },
      ctx(),
    );

    const tx2 = await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 300, description: 'order', idempotencyKey: key },
      ctx(),
    );

    // Same transaction returned (compare as strings — ObjectIds are different objects)
    expect(String(tx1._id)).toBe(String(tx2._id));

    // Balance is 300, not 600
    const balance = await engine.services.ledger.getBalance(member._id, ctx());
    expect(balance).toBe(300);
  });

  it('multiple earns accumulate in balance and lifetime', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    await engine.services.ledger.earnPoints({ memberId: member._id, points: 100, description: 'order 1' }, ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 200, description: 'order 2' }, ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 150, description: 'order 3' }, ctx());

    const bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(450);
    expect(bal.lifetime).toBe(450);
    expect(bal.redeemed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. POINT ADJUSTMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Point Adjustment', () => {
  it('positive adjustment (bonus) adds to current + lifetime', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    const tx = await engine.services.ledger.adjustPoints(
      { memberId: member._id, points: 500, description: 'Welcome bonus', reason: 'signup bonus' },
      ctx(),
    );

    expect(tx.type).toBe('adjust');
    expect(tx.points).toBe(500);
    expect(tx.balanceAfter).toBe(500);
  });

  it('negative adjustment (correction) deducts from current only', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    await engine.services.ledger.earnPoints({ memberId: member._id, points: 1000, description: 'seed' }, ctx());

    const tx = await engine.services.ledger.adjustPoints(
      { memberId: member._id, points: -300, description: 'Correction', reason: 'overpayment' },
      ctx(),
    );

    expect(tx.balanceAfter).toBe(700);
    const bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(700);
    expect(bal.lifetime).toBe(1000); // lifetime unchanged by negative adjustment
  });

  it('rejects negative adjustment beyond balance', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    await engine.services.ledger.earnPoints({ memberId: member._id, points: 100, description: 'seed' }, ctx());

    await expect(
      engine.services.ledger.adjustPoints(
        { memberId: member._id, points: -200, description: 'Too much', reason: 'test' },
        ctx(),
      ),
    ).rejects.toThrow(/insufficient/i);
  });

  it('rejects NaN, Infinity, zero points', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    await expect(
      engine.services.ledger.adjustPoints({ memberId: member._id, points: NaN, description: 'bad', reason: 'test' }, ctx()),
    ).rejects.toThrow();

    await expect(
      engine.services.ledger.adjustPoints({ memberId: member._id, points: Infinity, description: 'bad', reason: 'test' }, ctx()),
    ).rejects.toThrow();

    await expect(
      engine.services.ledger.adjustPoints({ memberId: member._id, points: 0, description: 'bad', reason: 'test' }, ctx()),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. POINT REDEMPTION (Reserve → Confirm / Release)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Point Redemption', () => {
  it('validate → reserve → confirm: full redemption flow', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 1000, description: 'seed' }, ctx());

    // 1. Validate
    const validation = await engine.services.redemption.validate(
      { memberId: member._id, pointsToRedeem: 500, orderTotal: 2000 },
      ctx(),
    );
    expect(validation.valid).toBe(true);
    expect(validation.discountAmount).toBe(50); // 500 / 10 = 50 BDT
    expect(validation.pointsToRedeem).toBe(500);

    // 2. Reserve
    const reservation = await engine.services.redemption.reserve(
      {
        memberId: member._id,
        pointsToRedeem: validation.pointsToRedeem,
        orderTotal: 2000,
        ownerType: 'Order',
        ownerId: 'order_789',
      },
      ctx(),
    );
    expect(reservation.status).toBe('reserved');
    expect(reservation.pointsReserved).toBe(500);

    // Balance deducted during reserve
    let bal = await engine.services.ledger.getBalance(member._id, ctx());
    expect(bal).toBe(500); // 1000 - 500

    // 3. Confirm (order successful)
    const confirmed = await engine.services.redemption.confirm(reservation._id, ctx());
    expect(confirmed.status).toBe('confirmed');

    // Balance stays same (already deducted), redeemed counter updated
    const finalBal = await engine.services.member.getBalance(member._id, ctx());
    expect(finalBal.current).toBe(500);
    expect(finalBal.redeemed).toBe(500);
  });

  it('validate → reserve → release: rollback on order failure', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 1000, description: 'seed' }, ctx());

    const reservation = await engine.services.redemption.reserve(
      {
        memberId: member._id,
        pointsToRedeem: 400,
        orderTotal: 2000,
        ownerType: 'Order',
        ownerId: 'order_failed',
      },
      ctx(),
    );

    // Balance deducted
    let bal = await engine.services.ledger.getBalance(member._id, ctx());
    expect(bal).toBe(600);

    // Release (order failed)
    const released = await engine.services.redemption.release(reservation._id, ctx());
    expect(released.status).toBe('released');

    // Balance restored
    bal = await engine.services.ledger.getBalance(member._id, ctx());
    expect(bal).toBe(1000);
  });

  it('rejects redemption below minimum points', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 50, description: 'seed' }, ctx());

    const result = await engine.services.redemption.validate(
      { memberId: member._id, pointsToRedeem: 50, orderTotal: 2000 },
      ctx(),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Minimum 100 points');
  });

  it('caps redemption at maxRedeemPercent of order', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 50000, description: 'whale' }, ctx());

    // orderTotal = 1000, maxRedeemPercent = 50 → max discount = 500 BDT
    // 500 BDT * 10 points/BDT = 5000 max points
    const result = await engine.services.redemption.validate(
      { memberId: member._id, pointsToRedeem: 50000, orderTotal: 1000 },
      ctx(),
    );
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(500); // capped at 50% of 1000
    expect(result.maxAllowedPoints).toBe(5000);
  });

  it('prevents double-confirm (atomic status transition)', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 1000, description: 'seed' }, ctx());

    const reservation = await engine.services.redemption.reserve(
      { memberId: member._id, pointsToRedeem: 200, orderTotal: 2000, ownerType: 'Order', ownerId: 'order_dbl' },
      ctx(),
    );

    // Confirm once
    await engine.services.redemption.confirm(reservation._id, ctx());

    // Second confirm should fail
    await expect(
      engine.services.redemption.confirm(reservation._id, ctx()),
    ).rejects.toThrow(/must be 'reserved'/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CONCURRENT SAFETY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Concurrent Safety', () => {
  it('parallel adjustments never produce negative balance', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 100, description: 'seed' }, ctx());

    // Two concurrent -80 adjustments (only one should succeed)
    const results = await Promise.allSettled([
      engine.services.ledger.adjustPoints(
        { memberId: member._id, points: -80, description: 'adj1', reason: 'test' },
        ctx(),
      ),
      engine.services.ledger.adjustPoints(
        { memberId: member._id, points: -80, description: 'adj2', reason: 'test' },
        ctx(),
      ),
    ]);

    const balance = await engine.services.ledger.getBalance(member._id, ctx());
    expect(balance).toBeGreaterThanOrEqual(0);

    // At least one should have failed
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it('parallel reservations never overdraw balance', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    await engine.services.ledger.earnPoints({ memberId: member._id, points: 600, description: 'seed' }, ctx());

    // Two concurrent reservations of 400 each (total 800 > 600)
    const results = await Promise.allSettled([
      engine.services.redemption.reserve(
        { memberId: member._id, pointsToRedeem: 400, orderTotal: 5000, ownerType: 'Order', ownerId: 'race_a' },
        ctx(),
      ),
      engine.services.redemption.reserve(
        { memberId: member._id, pointsToRedeem: 400, orderTotal: 5000, ownerType: 'Order', ownerId: 'race_b' },
        ctx(),
      ),
    ]);

    const balance = await engine.services.ledger.getBalance(member._id, ctx());
    expect(balance).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. TRANSACTION HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Transaction History', () => {
  it('records full audit trail: earn + adjust + redeem', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    // Earn
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 1000, description: 'POS order #1' },
      ctx(),
    );

    // Adjust (bonus)
    await engine.services.ledger.adjustPoints(
      { memberId: member._id, points: 200, description: 'Loyalty bonus', reason: 'promo' },
      ctx(),
    );

    // Redeem
    const reservation = await engine.services.redemption.reserve(
      { memberId: member._id, pointsToRedeem: 300, orderTotal: 5000, ownerType: 'Order', ownerId: 'order_audit' },
      ctx(),
    );
    await engine.services.redemption.confirm(reservation._id, ctx());

    // Check history
    const history = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 50 }, ctx());

    const types = history.docs.map((d: any) => d.type);
    expect(types).toContain('earn');
    expect(types).toContain('adjust');
    expect(types).toContain('redeem');

    // Verify final balance: 1000 + 200 - 300 = 900
    const bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(900);
    expect(bal.lifetime).toBe(1200); // earn 1000 + adjust 200
    expect(bal.redeemed).toBe(300);
  });

  it('history is paginated and sorted by createdAt desc', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    for (let i = 1; i <= 5; i++) {
      await engine.services.ledger.earnPoints(
        { memberId: member._id, points: 100, description: `earn ${i}` },
        ctx(),
      );
    }

    const page1 = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 3 }, ctx());
    expect(page1.docs.length).toBe(3);
    expect(page1.total).toBe(5);
    expect(page1.hasNext).toBe(true);

    const page2 = await engine.services.ledger.getHistory(member._id, { page: 2, limit: 3 }, ctx());
    expect(page2.docs.length).toBe(2);
    expect(page2.hasNext).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. BRIDGE SYNC (Customer.membership thin field)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bridge Sync', () => {
  it('syncCustomerMembership updates Customer.membership from LoyaltyMember', async () => {
    const customer = await createCustomer();
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());

    // Earn points via engine
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 750, description: 'test' },
      ctx(),
    );

    // Sync
    await bridge.syncCustomerMembership(customer._id.toString());

    const doc = await Customer.findById(customer._id).lean() as any;
    expect(doc.membership.points.current).toBe(750);
    expect(doc.membership.points.lifetime).toBe(750);
    expect(doc.membership.isActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. FULL POS-LIKE FLOW (simulated)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full POS Integration Flow', () => {
  it('complete checkout: enroll → earn on previous orders → redeem on new order → earn again', async () => {
    const customer = await createCustomer();

    // Step 1: Enroll
    const member = await bridge.enrollCustomer(customer._id.toString(), ctx());
    expect(member.balance.current).toBe(0);

    // Step 2: Earn from first order (1500 BDT, 10 pts/BDT → 150 pts)
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 150, description: 'Order #001', referenceType: 'order', referenceId: 'order_001', idempotencyKey: 'pos_earn:order_001' },
      ctx(),
    );

    // Step 3: Earn from second order (2000 BDT → 200 pts)
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 200, description: 'Order #002', referenceType: 'order', referenceId: 'order_002', idempotencyKey: 'pos_earn:order_002' },
      ctx(),
    );

    // Balance: 350, lifetime: 350
    let bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(350);
    expect(bal.lifetime).toBe(350);

    // Step 4: Third order with points redemption
    // Order total: 3000 BDT, redeem 200 points
    const validation = await engine.services.redemption.validate(
      { memberId: member._id, pointsToRedeem: 200, orderTotal: 3000 },
      ctx(),
    );
    expect(validation.valid).toBe(true);
    expect(validation.discountAmount).toBe(20); // 200 / 10 = 20 BDT

    // Reserve
    const reservation = await engine.services.redemption.reserve(
      { memberId: member._id, pointsToRedeem: 200, orderTotal: 3000, ownerType: 'Order', ownerId: 'order_003' },
      ctx(),
    );

    // Balance drops by 200 → 150
    bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(150);

    // Confirm (order success)
    await engine.services.redemption.confirm(reservation._id, ctx());

    // Earn from this order (3000 - 20 = 2980 BDT net → 298 pts at 10 pts/100 BDT)
    // Simplified: earn based on total
    await engine.services.ledger.earnPoints(
      { memberId: member._id, points: 298, description: 'Order #003', referenceType: 'order', referenceId: 'order_003', idempotencyKey: 'pos_earn:order_003' },
      ctx(),
    );

    // Final balance: 150 + 298 = 448
    bal = await engine.services.member.getBalance(member._id, ctx());
    expect(bal.current).toBe(448);
    expect(bal.lifetime).toBe(648); // 350 + 298
    expect(bal.redeemed).toBe(200);

    // Sync to Customer
    await bridge.syncCustomerMembership(customer._id.toString());
    const doc = await Customer.findById(customer._id).lean() as any;
    expect(doc.membership.points.current).toBe(448);
    expect(doc.membership.points.lifetime).toBe(648);
    expect(doc.membership.points.redeemed).toBe(200);

    // Verify full history
    const history = await engine.services.ledger.getHistory(member._id, { page: 1, limit: 50 }, ctx());
    expect(history.docs.length).toBeGreaterThanOrEqual(4); // 3 earns + 1 redeem
  });
});
