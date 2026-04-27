import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';

/**
 * Loyalty Bridge Integration Tests
 *
 * Tests the bridge between Customer model and LoyaltyMember.
 * Uses MongoMemoryServer from global setup.
 */

let Customer: typeof import('#resources/sales/customers/customer.model.js').default;
let bridge: typeof import('#resources/sales/loyalty/loyalty.bridge.js');
let engine: LoyaltyEngine;

// Mock the loyalty engine module-level accessor
let _mockEngine: LoyaltyEngine;

async function createTestCustomer(overrides: Record<string, unknown> = {}) {
  const phone = `017${Date.now().toString().slice(-8)}`;
  return Customer.create({
    name: { given: 'Test', family: 'Customer' },
    contact: { phone, email: `test-${phone}@example.com` },
    isActive: true,
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
    ...overrides,
  });
}

describe('Loyalty Bridge', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
    }

    // Create loyalty engine on the same connection
    engine = createLoyaltyEngine({
      mongoose: mongoose.connection,
      tenant: false,
    });

    // Ensure collections exist
    for (const model of Object.values(engine.models) as any[]) {
      await model.createCollection().catch(() => {});
    }

    Customer = (await import('#resources/sales/customers/customer.model.js')).default;

    // Set the engine so getLoyaltyEngine() works in bridge module
    const { setLoyaltyEngine } = await import('#resources/sales/loyalty/loyalty.plugin.js');
    setLoyaltyEngine(engine);

    bridge = await import('#resources/sales/loyalty/loyalty.bridge.js');
  });

  afterAll(async () => {
    // Clean up loyalty models
    for (const model of Object.values(engine.models) as any[]) {
      await model.deleteMany({});
    }
  });

  beforeEach(async () => {
    await Customer.deleteMany({});
    for (const model of Object.values(engine.models) as any[]) {
      await model.deleteMany({});
    }
  });

  const ctx = { actorId: 'test-user' };

  // ── enrollCustomer ──

  describe('enrollCustomer', () => {
    it('creates LoyaltyMember linked to customer._id', async () => {
      const customer = await createTestCustomer();
      const member = await bridge.enrollCustomer(customer._id.toString(), ctx);

      expect(member).toBeDefined();
      expect(member.externalId).toBe(customer._id.toString());
      expect(member.externalType).toBe('customer');
      expect(member.status).toBe('active');
      expect(member.balance.current).toBe(0);
    });

    it('updates Customer.membership thin field', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.membership).toBeDefined();
      expect(updated.membership.isActive).toBe(true);
      expect(updated.membership.enrolledAt).toBeDefined();
      expect(updated.membership.points.current).toBe(0);
      expect(updated.membership.points.lifetime).toBe(0);
      expect(updated.membership.cardId).toBeDefined();
    });

    it('throws if already enrolled', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);

      await expect(
        bridge.enrollCustomer(customer._id.toString(), ctx),
      ).rejects.toThrow(/already enrolled/i);
    });

    it('throws when customer not found', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      await expect(
        bridge.enrollCustomer(fakeId, ctx),
      ).rejects.toThrow(/not found/i);
    });
  });

  // ── getMemberForCustomer ──

  describe('getMemberForCustomer', () => {
    it('returns LoyaltyMember when enrolled', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);

      const member = await bridge.getMemberForCustomer(customer._id.toString(), ctx);
      expect(member).toBeDefined();
      expect(member!.externalId).toBe(customer._id.toString());
    });

    it('returns null when not enrolled', async () => {
      const customer = await createTestCustomer();
      const member = await bridge.getMemberForCustomer(customer._id.toString(), ctx);
      expect(member).toBeNull();
    });
  });

  // ── deactivateCustomerMembership ──

  describe('deactivateCustomerMembership', () => {
    it('deactivates member and updates Customer.membership.isActive', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);

      await bridge.deactivateCustomerMembership(customer._id.toString(), ctx);

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.membership.isActive).toBe(false);

      // LoyaltyMember should also be inactive
      const member = await bridge.getMemberForCustomer(customer._id.toString(), ctx);
      // Note: getMemberForCustomer calls getByExternalId which doesn't filter by status
      expect(member).toBeDefined();
      expect(member!.status).toBe('inactive');
    });

    it('throws when not enrolled', async () => {
      const customer = await createTestCustomer();
      await expect(
        bridge.deactivateCustomerMembership(customer._id.toString(), ctx),
      ).rejects.toThrow(/not enrolled/i);
    });
  });

  // ── reactivateCustomerMembership ──

  describe('reactivateCustomerMembership', () => {
    it('reactivates member and updates Customer.membership.isActive', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);
      await bridge.deactivateCustomerMembership(customer._id.toString(), ctx);

      await bridge.reactivateCustomerMembership(customer._id.toString(), ctx);

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.membership.isActive).toBe(true);
    });
  });

  // ── syncCustomerMembership ──

  describe('syncCustomerMembership', () => {
    it('syncs balance and tier from LoyaltyMember to Customer', async () => {
      const customer = await createTestCustomer();
      const member = await bridge.enrollCustomer(customer._id.toString(), ctx);

      // Simulate earned points by updating the LoyaltyMember balance directly
      // (earnPoints requires transactions/replica set which MongoMemoryServer doesn't support)
      const MemberModel = engine.models.Member;
      await MemberModel.findByIdAndUpdate(member._id, {
        $inc: { 'balance.current': 500, 'balance.lifetime': 500 },
      });

      // Sync
      await bridge.syncCustomerMembership(customer._id.toString());

      const updated = await Customer.findById(customer._id).lean() as any;
      expect(updated.membership.points.current).toBe(500);
      expect(updated.membership.points.lifetime).toBe(500);
    });
  });

  // ── requireMemberForCustomer ──

  describe('requireMemberForCustomer', () => {
    it('returns member when enrolled', async () => {
      const customer = await createTestCustomer();
      await bridge.enrollCustomer(customer._id.toString(), ctx);

      const member = await bridge.requireMemberForCustomer(customer._id.toString(), ctx);
      expect(member).toBeDefined();
      expect(member._id).toBeDefined();
    });

    it('throws when not enrolled', async () => {
      const customer = await createTestCustomer();
      await expect(
        bridge.requireMemberForCustomer(customer._id.toString(), ctx),
      ).rejects.toThrow(/not enrolled/i);
    });
  });
});
