import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

/**
 * Customer Stats Tests
 *
 * Tests for the DB-backed customer-stats hooks:
 * - onOrderCreated, onOrderCompleted, onOrderCancelled, onOrderRefunded
 *
 * Note: The legacy pure helpers `calculatePointsForOrder` and
 * `getTierDiscountPercent` were removed when loyalty switched from a
 * config-driven calculator to an engine + earning-rules model. The new
 * surface is `previewPointsForOrder` in `loyalty.bridge.ts`, exercised
 * via the @classytic/loyalty engine in `tests/integration/loyalty-e2e.test.ts`.
 */

let shouldDisconnect = false;
let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let customerStats: typeof import('#resources/sales/customers/customer.stats.js');

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
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Customer.deleteMany({});
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
