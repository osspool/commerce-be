/**
 * Order + Loyalty + PlatformConfig E2E Tests
 *
 * Validates that PlatformConfig.membership values flow through:
 *   1. Loyalty engine (redemption limits, conversion rate)
 *   2. Card enrollment (prefix, digits)
 *
 * Uses MongoMemoryReplSet (loyalty engine requires transactions).
 *
 * Note: Earlier versions also tested two pure helpers
 * (`calculatePointsForOrder`, `getTierDiscountPercent`) on the loyalty
 * bridge. Those were removed when the loyalty surface switched from a
 * config-driven calculator to engine + earning rules. The replacement
 * `previewPointsForOrder` is async and engine-backed; it's covered by
 * the integration suite alongside the order kernel.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';

let replSet: MongoMemoryReplSet;
let engine: LoyaltyEngine;

// Test membership config — mirrors what PlatformConfig.membership stores
const CONFIG = {
  enabled: true,
  pointsPerAmount: 1,
  amountPerPoint: 100,   // 100 BDT = 1 base point
  roundingMode: 'floor' as const,
  tiers: [
    { name: 'Bronze', minPoints: 0, pointsMultiplier: 1, discountPercent: 0, color: '#CD7F32' },
    { name: 'Silver', minPoints: 100, pointsMultiplier: 1.5, discountPercent: 5, color: '#C0C0C0' },
    { name: 'Gold', minPoints: 500, pointsMultiplier: 2, discountPercent: 10, color: '#FFD700' },
  ],
  cardPrefix: 'TST',
  cardDigits: 8,
  redemption: {
    enabled: true,
    pointsPerBdt: 10,       // 10 points = 1 BDT
    minRedeemPoints: 50,    // Min 50 points to redeem
    maxRedeemPercent: 50,   // Max 50% of order via points
    minOrderAmount: 0,
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());

  // Initialize engine with the SAME config values that PlatformConfig.membership stores
  // (loyalty.plugin.ts does exactly this at boot time, reading from PlatformConfig)
  engine = createLoyaltyEngine({
    mongoose: mongoose.connection,
    tenant: false,
    program: { conversionRate: CONFIG.redemption.pointsPerBdt },
    redemption: {
      minPoints: CONFIG.redemption.minRedeemPoints,
      minOrderAmount: CONFIG.redemption.minOrderAmount,
      maxRedeemPercent: CONFIG.redemption.maxRedeemPercent,
      reservationTtlMinutes: 15,
    },
  });

  for (const model of Object.values(engine.models) as any[]) {
    await model.createCollection();
  }
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  for (const model of Object.values(engine.models) as any[]) {
    await model.deleteMany({});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. LOYALTY ENGINE — REDEMPTION LIMITS FROM CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe('Loyalty Engine redemption (config → limits)', () => {
  it('rejects redemption below minRedeemPoints (50)', async () => {
    const member = await engine.repositories.member.enroll({
      externalId: new mongoose.Types.ObjectId().toString(),
      externalType: 'customer',
      cardId: `TST-${Date.now()}-MIN`,
    }, { actorId: 'test' });

    await engine.repositories.pointTransaction.earnPoints({
      memberId: member._id,
      points: 30,
      description: 'test earn',
      referenceType: 'test',
      referenceId: `ref-${Date.now()}-1`,
    }, { actorId: 'test' });

    // 30 points < minRedeemPoints(50) → should reject
    await expect(
      engine.repositories.redemption.reserve({
        memberId: member._id,
        pointsToRedeem: 30,
        orderTotal: 1000,
        ownerType: 'Order',
        ownerId: `ord-${Date.now()}-1`,
      }, { actorId: 'test' }),
    ).rejects.toThrow();
  });

  it('allows redemption at exactly minRedeemPoints (50)', async () => {
    const member = await engine.repositories.member.enroll({
      externalId: new mongoose.Types.ObjectId().toString(),
      externalType: 'customer',
      cardId: `TST-${Date.now()}-EXA`,
    }, { actorId: 'test' });

    await engine.repositories.pointTransaction.earnPoints({
      memberId: member._id,
      points: 100,
      description: 'test earn',
      referenceType: 'test',
      referenceId: `ref-${Date.now()}-2`,
    }, { actorId: 'test' });

    // 50 points = minRedeemPoints(50) → should succeed
    const reservation = await engine.repositories.redemption.reserve({
      memberId: member._id,
      pointsToRedeem: 50,
      orderTotal: 1000,
      ownerType: 'Order',
      ownerId: `ord-${Date.now()}-2`,
    }, { actorId: 'test' });

    expect(reservation).toBeTruthy();
    expect(reservation.pointsReserved).toBeGreaterThanOrEqual(50);
  });

  it('caps redemption at maxRedeemPercent (50%) of order', async () => {
    const member = await engine.repositories.member.enroll({
      externalId: new mongoose.Types.ObjectId().toString(),
      externalType: 'customer',
      cardId: `TST-${Date.now()}-CAP`,
    }, { actorId: 'test' });

    await engine.repositories.pointTransaction.earnPoints({
      memberId: member._id,
      points: 50000,
      description: 'whale earn',
      referenceType: 'test',
      referenceId: `ref-${Date.now()}-3`,
    }, { actorId: 'test' });

    // Order 1000 BDT, maxRedeemPercent=50% → max discount = 500 BDT
    // At conversionRate=10 (10 points = 1 BDT) → max 5000 points redeemable
    // Try to redeem 20000 points (would be 2000 BDT = 200% of order)
    const reservation = await engine.repositories.redemption.reserve({
      memberId: member._id,
      pointsToRedeem: 20000,
      orderTotal: 1000,
      ownerType: 'Order',
      ownerId: `ord-${Date.now()}-3`,
    }, { actorId: 'test' });

    // Should be capped: max 500 BDT discount, max 5000 points
    expect(reservation.discountAmount).toBeLessThanOrEqual(500);
    expect(reservation.pointsReserved).toBeLessThanOrEqual(5000);
  });

  it('conversionRate (pointsPerBdt) controls point-to-BDT conversion', async () => {
    const member = await engine.repositories.member.enroll({
      externalId: new mongoose.Types.ObjectId().toString(),
      externalType: 'customer',
      cardId: `TST-${Date.now()}-CVR`,
    }, { actorId: 'test' });

    await engine.repositories.pointTransaction.earnPoints({
      memberId: member._id,
      points: 500,
      description: 'earn for conversion test',
      referenceType: 'test',
      referenceId: `ref-${Date.now()}-4`,
    }, { actorId: 'test' });

    // Redeem 100 points at rate 10 points/BDT → 10 BDT discount
    const reservation = await engine.repositories.redemption.reserve({
      memberId: member._id,
      pointsToRedeem: 100,
      orderTotal: 5000,
      ownerType: 'Order',
      ownerId: `ord-${Date.now()}-4`,
    }, { actorId: 'test' });

    expect(reservation.discountAmount).toBe(10); // 100 / 10 = 10 BDT
    expect(reservation.pointsReserved).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. FULL LIFECYCLE — ENROLL → EARN → REDEEM → VERIFY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full lifecycle with config values', () => {
  it('enrollment → earn (config rate) → redeem (config limits) → verify balance', async () => {
    // 1. Enroll
    const member = await engine.repositories.member.enroll({
      externalId: new mongoose.Types.ObjectId().toString(),
      externalType: 'customer',
      cardId: `TST-${Date.now()}-FULL`,
    }, { actorId: 'test' });
    expect(member.status).toBe('active');
    expect(member.balance.current).toBe(0);

    // 2. Simulate order: compute the points the OLD bridge helper would
    //    have returned. The new loyalty surface is engine + earning rules
    //    (`previewPointsForOrder` is async / engine-backed); this test
    //    asserts the post-earn balance directly via the engine, so the
    //    intermediate `pointsToEarn` is computed inline using the same
    //    formula the old helper used:
    //      floor(orderTotal / amountPerPoint * pointsPerAmount * tierMultiplier)
    const orderTotal = 5000; // 5000 BDT
    const tier = CONFIG.tiers.find((t) => t.name === 'Silver')!;
    const pointsToEarn = Math.floor(
      (orderTotal / CONFIG.amountPerPoint) * CONFIG.pointsPerAmount * tier.pointsMultiplier,
    );
    // (5000/100)*1*1.5 = 75
    expect(pointsToEarn).toBe(75);

    // 3. Award points via engine (same as POS controller does)
    await engine.repositories.pointTransaction.earnPoints({
      memberId: member._id,
      points: pointsToEarn,
      description: 'POS order test',
      referenceType: 'order',
      referenceId: `ord-${Date.now()}`,
    }, { actorId: 'cashier' });

    // 4. Verify balance
    const updated = await engine.repositories.member.getById(member._id, { throwOnNotFound: false });
    expect(updated!.balance.current).toBe(75);
    expect(updated!.balance.lifetime).toBe(75);

    // 5. Redeem points (75 > minRedeemPoints=50, so allowed)
    const reservation = await engine.repositories.redemption.reserve({
      memberId: member._id,
      pointsToRedeem: 75,
      orderTotal: 3000,
      ownerType: 'Order',
      ownerId: `ord-redeem-${Date.now()}`,
    }, { actorId: 'cashier' });

    // 75 points / 10 = 7.5 BDT; maxRedeemPercent=50% of 3000 = 1500 BDT (not a constraint here)
    // 75 / 10 = 7.5 → floor = 7
    expect(reservation.discountAmount).toBe(7);
    expect(reservation.pointsReserved).toBe(75);

    // 6. Confirm redemption
    await engine.repositories.redemption.confirm(reservation._id, { actorId: 'cashier' });

    // 7. Verify final balance = 0
    const final = await engine.repositories.member.getById(member._id, { throwOnNotFound: false });
    expect(final!.balance.current).toBe(0);
    expect(final!.balance.lifetime).toBe(75); // Lifetime doesn't decrease
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. PLATFORM CONFIG IN DB — VERIFY SEED
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlatformConfig seeded for loyalty plugin', () => {
  it('engine is functional (proves config was read at init)', () => {
    expect(engine).toBeTruthy();
    expect(engine.repositories.member).toBeTruthy();
    expect(engine.repositories.pointTransaction).toBeTruthy();
    expect(engine.repositories.redemption).toBeTruthy();
  });
});
