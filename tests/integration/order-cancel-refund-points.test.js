// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

/**
 * Order Cancel/Refund Points Restoration Tests
 *
 * Tests that membership points redeemed during checkout are properly
 * restored to the customer when an order is cancelled or refunded.
 *
 * Critical scenarios tested:
 * 1. POS order with points redemption → Cancel → Points restored
 * 2. POS order with points redemption → Refund → Points restored
 * 3. Order without points redemption → Cancel → No points change
 */
describe('Order Cancel/Refund Points Restoration', () => {
  let app;
  let adminToken;
  let branch;
  let product;
  let customer;
  let Customer;
  let Order;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const testData = await import('../helpers/test-data.js');
    const { createTestUser, createTestStock } = testData;

    app = await createTestServer();
    const admin = await createTestUser(app, { role: 'admin' });
    adminToken = admin.token;

    // Get model references
    Customer = mongoose.models.Customer;
    Order = mongoose.models.Order;
    const Product = mongoose.models.Product;
    const Branch = mongoose.models.Branch;
    const PlatformConfig = mongoose.models.PlatformConfig;

    // Setup: Create Product
    const uniqueSku = `CANCEL-TEST-${Date.now()}`;
    product = await Product.create(testData.createTestProduct({
      name: 'Cancel/Refund Test Product',
      basePrice: 1000,
      category: 'clothing',
      sku: uniqueSku,
    }));

    // Setup: Create Branch
    await Branch.deleteMany({ code: 'CANCEL-TEST' });
    branch = await Branch.create(testData.createTestBranch({
      name: 'Cancel Test Branch',
      code: 'CANCEL-TEST',
      address: { city: 'Dhaka' },
    }));

    // Setup: Add Stock (enough for multiple orders)
    await createTestStock(app, {
      product: product._id,
      branch: branch._id,
      quantity: 200,
    });

    // Setup: Create Customer with membership and points
    customer = await Customer.create({
      name: 'Points Restoration Test Customer',
      phone: `0171${Date.now().toString().slice(-7)}`,
      email: `cancel-test-${Date.now()}@example.com`,
      membership: {
        cardId: `TEST-${Date.now().toString().slice(-8)}`,
        isActive: true,
        enrolledAt: new Date(),
        points: {
          current: 500, // Start with 500 points
          lifetime: 500,
          redeemed: 0,
        },
        tier: 'Silver',
      },
    });

    // Setup: Enable membership with redemption in platform config
    await PlatformConfig.findOneAndUpdate(
      { isSingleton: true },
      {
        $set: {
          membership: {
            enabled: true,
            pointsPerAmount: 1,
            amountPerPoint: 100,
            roundingMode: 'floor',
            tiers: [
              { name: 'Bronze', minPoints: 0, pointsMultiplier: 1, discountPercent: 0 },
              { name: 'Silver', minPoints: 50, pointsMultiplier: 1.25, discountPercent: 2 },
              { name: 'Gold', minPoints: 200, pointsMultiplier: 1.5, discountPercent: 5 },
            ],
            cardPrefix: 'TEST',
            cardDigits: 8,
            redemption: {
              enabled: true,
              minRedeemPoints: 10,
              minOrderAmount: 0,
              pointsPerBdt: 10, // 10 points = 1 BDT
              maxRedeemPercent: 50,
            },
          },
        },
      },
      { upsert: true }
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ============================================
  // CANCEL FLOW TESTS
  // ============================================

  describe('Order Cancellation', () => {
    let orderWithRedemption;

    it('should create POS order with points redemption', async () => {
      // Verify starting points
      const customerBefore = await Customer.findById(customer._id).lean();
      expect(customerBefore.membership.points.current).toBe(500);
      expect(customerBefore.membership.points.redeemed).toBe(0);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: customer.membership.cardId,
          pointsToRedeem: 100, // Redeem 100 points = 10 BDT discount
          payment: { method: 'cash', amount: 970 }, // 1000 - 2% tier - 10 redemption
          deliveryMethod: 'pickup',
        },
      });

      const body = response.json();
      if (response.statusCode !== 201) {
        console.error('POS Order Error:', JSON.stringify(body, null, 2));
      }
      expect(response.statusCode).toBe(201);
      expect(body.data.membershipApplied.pointsRedeemed).toBe(100);
      expect(body.data.membershipApplied.pointsRedemptionDiscount).toBe(10);

      orderWithRedemption = body.data;

      // Verify points were deducted
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(400); // 500 - 100
      expect(customerAfter.membership.points.redeemed).toBe(100);
    });

    it('should restore points when order is cancelled', async () => {
      // Cancel the order
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${orderWithRedemption._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          status: 'cancelled',
          cancellationReason: 'Test cancellation for points restoration',
        },
      });

      const body = response.json();
      if (response.statusCode !== 200) {
        console.error('Cancel Order Error:', JSON.stringify(body, null, 2));
      }
      expect(response.statusCode).toBe(200);
      expect(body.data.status).toBe('cancelled');

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify points were restored
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(500); // Restored to 500
      expect(customerAfter.membership.points.redeemed).toBe(0); // Redeemed counter decreased
    });

    it('should not affect points for order without redemption', async () => {
      // Get current points
      const customerBefore = await Customer.findById(customer._id).lean();
      const pointsBefore = customerBefore.membership.points.current;

      // Create order WITHOUT points redemption
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: customer.membership.cardId,
          // No pointsToRedeem
          payment: { method: 'cash', amount: 980 }, // 1000 - 2% tier
          deliveryMethod: 'pickup',
        },
      });

      expect(createResponse.statusCode).toBe(201);
      const order = createResponse.json().data;
      expect(order.membershipApplied.pointsRedeemed).toBe(0);

      // Cancel the order
      const cancelResponse = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${order._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { status: 'cancelled' },
      });

      expect(cancelResponse.statusCode).toBe(200);

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify points unchanged (except for earned points which shouldn't be awarded for cancelled)
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(pointsBefore);
    });
  });

  // ============================================
  // REFUND FLOW TESTS
  // ============================================

  describe('Order Refund', () => {
    let orderForRefund;

    it('should create POS order with points redemption for refund test', async () => {
      // Refresh customer to get current points
      const customerBefore = await Customer.findById(customer._id).lean();
      const pointsBefore = customerBefore.membership.points.current;

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: customer.membership.cardId,
          pointsToRedeem: 150, // Redeem 150 points = 15 BDT discount
          payment: { method: 'cash', amount: 965 }, // 1000 - 2% tier - 15 redemption
          deliveryMethod: 'pickup',
        },
      });

      const body = response.json();
      expect(response.statusCode).toBe(201);
      expect(body.data.membershipApplied.pointsRedeemed).toBe(150);

      orderForRefund = body.data;

      // Verify points were deducted
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(pointsBefore - 150);
    });

    it('should restore points when order is refunded', async () => {
      // Get points before refund
      const customerBefore = await Customer.findById(customer._id).lean();
      const pointsBefore = customerBefore.membership.points.current;

      // Refund the order (update payment status to refunded)
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${orderForRefund._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          currentPayment: {
            ...orderForRefund.currentPayment,
            status: 'refunded',
          },
        },
      });

      const body = response.json();
      if (response.statusCode !== 200) {
        console.error('Refund Order Error:', JSON.stringify(body, null, 2));
      }
      expect(response.statusCode).toBe(200);
      expect(body.data.currentPayment.status).toBe('refunded');

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify points were restored
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(pointsBefore + 150); // Restored
    });
  });

  // ============================================
  // EDGE CASE TESTS
  // ============================================

  describe('Edge Cases', () => {
    it('should handle cancellation when customer no longer exists', async () => {
      // Create a temporary customer
      const tempCustomer = await Customer.create({
        name: 'Temporary Customer',
        phone: `0172${Date.now().toString().slice(-7)}`,
        membership: {
          cardId: `TEMP-${Date.now().toString().slice(-8)}`,
          isActive: true,
          enrolledAt: new Date(),
          points: { current: 200, lifetime: 200, redeemed: 0 },
          tier: 'Bronze',
        },
      });

      // Create order with points redemption
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: tempCustomer.membership.cardId,
          pointsToRedeem: 50,
          payment: { method: 'cash', amount: 995 },
          deliveryMethod: 'pickup',
        },
      });

      expect(createResponse.statusCode).toBe(201);
      const order = createResponse.json().data;

      // Delete the customer (simulating edge case)
      await Customer.findByIdAndDelete(tempCustomer._id);

      // Cancel the order - should not throw, just log error
      const cancelResponse = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${order._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { status: 'cancelled' },
      });

      // Cancellation should still succeed even if points restoration fails
      expect(cancelResponse.statusCode).toBe(200);
      expect(cancelResponse.json().data.status).toBe('cancelled');
    });

    it('should not double-restore points on duplicate cancellation events', async () => {
      // Create order with points redemption
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: customer.membership.cardId,
          pointsToRedeem: 80,
          payment: { method: 'cash', amount: 972 },
          deliveryMethod: 'pickup',
        },
      });

      expect(createResponse.statusCode).toBe(201);
      const order = createResponse.json().data;

      // Get points before cancellation
      const customerBefore = await Customer.findById(customer._id).lean();

      // Cancel the order
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${order._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { status: 'cancelled' },
      });

      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify points were restored exactly once
      const customerAfter = await Customer.findById(customer._id).lean();
      expect(customerAfter.membership.points.current).toBe(customerBefore.membership.points.current + 80);

      // Try to cancel again (should be no-op for points)
      const secondCancelResponse = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orders/${order._id}`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { status: 'cancelled' },
      });

      await new Promise(resolve => setTimeout(resolve, 150));

      // Points should not change again
      const customerFinal = await Customer.findById(customer._id).lean();
      expect(customerFinal.membership.points.current).toBe(customerAfter.membership.points.current);
    });
  });
});
