import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

/**
 * Customer Stats Tests
 *
 * Tests for customer.stats.ts pure functions and DB-backed stat tracking:
 * - calculatePointsForOrder (pure)
 * - getTierDiscountPercent (pure)
 * - onOrderCreated, onOrderCompleted, onOrderCancelled, onOrderRefunded (DB)
 *
 * Note: Membership point operations (earn, redeem, reserve, release, adjust) are now
 * tested in tests/integration/loyalty-e2e.test.ts via the @classytic/loyalty engine.
 */

let shouldDisconnect = false;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let customerStats: typeof import('#resources/sales/customers/customer.stats.js');
let loyaltyBridge: typeof import('#resources/sales/loyalty/loyalty.bridge.js');

async function createCustomerWithMembership(overrides: Record<string, unknown> = {}) {
  const phone = `017${Date.now().toString().slice(-8)}`;
  return Customer.create({
    name: { given: 'Test', family: 'Customer' },
    contact: { phone, email: `test-${phone}@example.com` },
    isActive: true,
    membership: {
      isActive: true,
      enrolledAt: new Date(),
      points: { current: 500, lifetime: 1000, redeemed: 200 },
      tier: 'Silver',
    },
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
    ...overrides,
  });
}

describe('Customer Stats', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
      shouldDisconnect = true;
    }

    Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    customerStats = await import('#resources/sales/customers/customer.stats.js');
    loyaltyBridge = await import('#resources/sales/loyalty/loyalty.bridge.js');
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Customer.deleteMany({});
  });

  // ─── calculatePointsForOrder (pure function) ──────────

  describe('calculatePointsForOrder', () => {
    const config = {
      enabled: true,
      amountPerPoint: 100,
      pointsPerAmount: 1,
      roundingMode: 'floor' as const,
      tiers: [
        { name: 'Bronze', minPoints: 0, pointsMultiplier: 1 },
        { name: 'Silver', minPoints: 500, pointsMultiplier: 1.5 },
        { name: 'Gold', minPoints: 2000, pointsMultiplier: 2, discountPercent: 5 },
      ],
    };

    it('calculates base points for Bronze tier', () => {
      const points = loyaltyBridge.calculatePointsForOrder(1000, config, 'Bronze');
      expect(points).toBe(10);
    });

    it('applies tier multiplier for Silver', () => {
      const points = loyaltyBridge.calculatePointsForOrder(1000, config, 'Silver');
      expect(points).toBe(15);
    });

    it('applies tier multiplier for Gold', () => {
      const points = loyaltyBridge.calculatePointsForOrder(1000, config, 'Gold');
      expect(points).toBe(20);
    });

    it('floors fractional points by default', () => {
      const points = loyaltyBridge.calculatePointsForOrder(150, config, 'Silver');
      expect(points).toBe(2);
    });

    it('uses ceil rounding mode', () => {
      const ceilConfig = { ...config, roundingMode: 'ceil' as const };
      const points = loyaltyBridge.calculatePointsForOrder(150, ceilConfig, 'Silver');
      expect(points).toBe(3);
    });

    it('uses round rounding mode', () => {
      const roundConfig = { ...config, roundingMode: 'round' as const };
      const points = loyaltyBridge.calculatePointsForOrder(150, roundConfig, 'Silver');
      expect(points).toBe(2);
    });

    it('returns 0 when membership is not enabled', () => {
      const disabledConfig = { ...config, enabled: false };
      const points = loyaltyBridge.calculatePointsForOrder(1000, disabledConfig, 'Bronze');
      expect(points).toBe(0);
    });

    it('returns 0 when order total is 0', () => {
      const points = loyaltyBridge.calculatePointsForOrder(0, config, 'Bronze');
      expect(points).toBe(0);
    });
  });

  // ─── getTierDiscountPercent (pure function) ────────────

  describe('getTierDiscountPercent', () => {
    const config = {
      enabled: true,
      tiers: [
        { name: 'Bronze', minPoints: 0 },
        { name: 'Gold', minPoints: 2000, discountPercent: 5 },
      ],
    };

    it('returns discount percent for matching tier', () => {
      const discount = loyaltyBridge.getTierDiscountPercent('Gold', config);
      expect(discount).toBe(5);
    });

    it('returns 0 for tier without discount', () => {
      const discount = loyaltyBridge.getTierDiscountPercent('Bronze', config);
      expect(discount).toBe(0);
    });

    it('returns 0 when membership is disabled', () => {
      const discount = loyaltyBridge.getTierDiscountPercent('Gold', { enabled: false });
      expect(discount).toBe(0);
    });
  });

  // ─── Customer Stats (DB) ──────────────────────────────

  describe('onOrderCreated / onOrderCompleted / onOrderCancelled / onOrderRefunded', () => {
    it('increments orders.total and sets dates on order created', async () => {
      const customer = await createCustomerWithMembership();
      await customerStats.onOrderCreated(customer._id.toString());

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.stats.orders.total).toBe(1);
      expect(updated.stats.lastOrderDate).toBeDefined();
      expect(updated.stats.firstOrderDate).toBeDefined();
    });

    it('does not overwrite firstOrderDate on subsequent orders', async () => {
      const customer = await createCustomerWithMembership();
      await customerStats.onOrderCreated(customer._id.toString());
      const afterFirst = await Customer.findById(customer._id).lean() as any;
      const firstDate = afterFirst.stats.firstOrderDate;

      await new Promise(r => setTimeout(r, 50));
      await customerStats.onOrderCreated(customer._id.toString());

      const afterSecond = await Customer.findById(customer._id).lean() as any;
      expect(afterSecond.stats.orders.total).toBe(2);
      expect(new Date(afterSecond.stats.firstOrderDate).getTime()).toBe(new Date(firstDate).getTime());
    });

    it('increments completed count and revenue on order completed', async () => {
      const customer = await createCustomerWithMembership();
      await customerStats.onOrderCompleted(customer._id.toString(), 5000);

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.stats.orders.completed).toBe(1);
      expect(updated.stats.revenue.total).toBe(5000);
      expect(updated.stats.revenue.lifetime).toBe(5000);
    });

    it('increments cancelled count on order cancelled', async () => {
      const customer = await createCustomerWithMembership();
      await customerStats.onOrderCancelled(customer._id.toString());

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.stats.orders.cancelled).toBe(1);
    });

    it('adjusts stats on order refund', async () => {
      const customer = await createCustomerWithMembership();
      await customerStats.onOrderCompleted(customer._id.toString(), 3000);
      await customerStats.onOrderRefunded(customer._id.toString(), 3000);

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.stats.orders.refunded).toBe(1);
      expect(updated.stats.orders.completed).toBe(0);
      expect(updated.stats.revenue.total).toBe(0);
      expect(updated.stats.revenue.lifetime).toBe(3000); // lifetime NOT decremented
    });

    it('no-ops gracefully when customerId is empty', async () => {
      await customerStats.onOrderCreated('');
      await customerStats.onOrderCompleted('', 1000);
      await customerStats.onOrderCancelled('');
      await customerStats.onOrderRefunded('', 1000);
    });
  });
});
