// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

describe('Membership Flow Integration', () => {
  let app;
  let adminToken;
  let branch;
  let product;
  let customer;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const testData = await import('../helpers/test-data.js');
    const { createTestUser, createTestStock } = testData;

    app = await createTestServer();
    const admin = await createTestUser(app, { role: 'admin' });
    adminToken = admin.token;

    // Setup: Create Product
    const Product = mongoose.models.Product;
    const uniqueSku = `MBSHIP-TEST-${Date.now()}`;
    product = await Product.create(testData.createTestProduct({
      name: 'Membership Test Product',
      basePrice: 1000,
      category: 'clothing',
      sku: uniqueSku
    }));

    // Setup: Create Branch
    const Branch = mongoose.models.Branch;
    await Branch.deleteMany({ code: 'MBR-TEST' });
    branch = await Branch.create(testData.createTestBranch({
      name: 'Membership Test Branch',
      code: 'MBR-TEST',
      address: { city: 'Dhaka' }
    }));

    // Setup: Add Stock
    await createTestStock(app, {
      product: product._id,
      branch: branch._id,
      quantity: 100
    });

    // Setup: Create Customer
    const Customer = mongoose.models.Customer;
    customer = await Customer.create({
      name: 'Membership Test Customer',
      phone: `0171${Date.now().toString().slice(-7)}`,
      email: `member-test-${Date.now()}@example.com`,
    });

    // Setup: Enable membership in platform config
    const PlatformConfig = mongoose.models.PlatformConfig;
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
              { name: 'Platinum', minPoints: 500, pointsMultiplier: 2, discountPercent: 10 },
            ],
            cardPrefix: 'TEST',
            cardDigits: 8,
          }
        }
      },
      { upsert: true }
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should enroll customer in membership program', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customer._id}/enroll-membership`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.membership).toBeDefined();
    expect(body.data.membership.cardId).toMatch(/^TEST-\d{8}$/);
    expect(body.data.membership.tier).toBe('Bronze');
    expect(body.data.membership.points.current).toBe(0);
    expect(body.data.membership.isActive).toBe(true);

    // Update customer reference with membership data
    customer = body.data;
  });

  it('should reject duplicate enrollment', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customer._id}/enroll-membership`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('already has');
  });

  it('should lookup customer by membership card ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers?membership.cardId=${customer.membership.cardId}`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.docs.length).toBe(1);
    expect(body.docs[0].membership.cardId).toBe(customer.membership.cardId);
  });

  it('should create POS order with membership card and earn points', async () => {
    const orderPayload = {
      items: [{
        productId: product._id,
        quantity: 1,
        price: 1000
      }],
      branchId: branch._id,
      membershipCardId: customer.membership.cardId,
      payment: { method: 'cash', amount: 1000 },
      deliveryMethod: 'pickup'
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload
    });

    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body.success).toBe(true);

    // Verify membership applied
    expect(body.data.membershipApplied).toBeDefined();
    expect(body.data.membershipApplied.cardId).toBe(customer.membership.cardId);
    expect(body.data.membershipApplied.tier).toBe('Bronze');
    expect(body.data.membershipApplied.pointsEarned).toBe(10); // 1000 / 100 = 10 points
    expect(body.data.membershipApplied.tierDiscountApplied).toBe(0); // Bronze has no discount

    // Verify customer linked
    expect(body.data.customer).toBeDefined();
    expect(body.data.customerPhone).toBe(customer.phone);
  });

  it('should verify points were awarded to customer', async () => {
    // Give a small delay for async event processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customer._id}`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.data.membership.points.current).toBe(10);
    expect(body.data.membership.points.lifetime).toBe(10);
  });

  it('should include membership info in receipt', async () => {
    // Get the last created order
    const Order = mongoose.models.Order;
    const order = await Order.findOne({ customer: customer._id }).sort({ createdAt: -1 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pos/orders/${order._id}/receipt`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.data.membership).toBeDefined();
    expect(body.data.membership.cardId).toBe(customer.membership.cardId);
    expect(body.data.membership.tier).toBe('Bronze');
    expect(body.data.membership.pointsEarned).toBe(10);
  });

  it('should upgrade tier when points threshold is reached', async () => {
    // Create enough orders to reach Silver tier (50 points)
    // Need 4 more orders of 1000 BDT each = 40 more points (total 50)
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/pos/orders',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {
          items: [{ productId: product._id, quantity: 1 }],
          branchId: branch._id,
          membershipCardId: customer.membership.cardId,
          payment: { method: 'cash', amount: 1000 },
          deliveryMethod: 'pickup'
        }
      });
    }

    // Allow async event processing
    await new Promise(resolve => setTimeout(resolve, 200));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customer._id}`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.data.membership.points.lifetime).toBe(50); // 10 + 40 = 50
    expect(body.data.membership.tier).toBe('Silver'); // Should upgrade to Silver at 50 points
  });

  it('should apply tier discount on next order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        items: [{ productId: product._id, quantity: 1 }],
        branchId: branch._id,
        membershipCardId: customer.membership.cardId,
        payment: { method: 'cash', amount: 980 }, // 1000 - 2% = 980
        deliveryMethod: 'pickup'
      }
    });

    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body.data.membershipApplied.tier).toBe('Silver');
    expect(body.data.membershipApplied.tierDiscountPercent).toBe(2);
    expect(body.data.membershipApplied.tierDiscountApplied).toBe(20); // 2% of 1000
    expect(body.data.discountAmount).toBe(20);
    expect(body.data.totalAmount).toBe(980);
  });

  it('should deactivate membership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customer._id}/deactivate-membership`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.membership.isActive).toBe(false);
  });

  it('should not apply membership benefits when deactivated', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        items: [{ productId: product._id, quantity: 1 }],
        branchId: branch._id,
        membershipCardId: customer.membership.cardId, // Still passing card but it's inactive
        payment: { method: 'cash', amount: 1000 },
        deliveryMethod: 'pickup'
      }
    });

    // Should fail because card is inactive
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('not found');
  });

  // ============================================
  // CACHE INVALIDATION TESTS
  // These tests verify that platform config changes
  // propagate correctly through the caching layer
  // ============================================

  it('should reactivate membership for cache tests', async () => {
    // Reactivate membership for subsequent tests
    const Customer = mongoose.models.Customer;
    await Customer.findByIdAndUpdate(customer._id, {
      'membership.isActive': true
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customer._id}`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.membership.isActive).toBe(true);
  });

  it('should use updated tier discounts after platform config change (cache invalidation)', async () => {
    // Update Silver tier discount from 2% to 8% via platform config API
    const configUpdateResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform/config',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        membership: {
          enabled: true,
          pointsPerAmount: 1,
          amountPerPoint: 100,
          roundingMode: 'floor',
          tiers: [
            { name: 'Bronze', minPoints: 0, pointsMultiplier: 1, discountPercent: 0 },
            { name: 'Silver', minPoints: 50, pointsMultiplier: 1.25, discountPercent: 8 }, // Changed from 2% to 8%
            { name: 'Gold', minPoints: 200, pointsMultiplier: 1.5, discountPercent: 5 },
            { name: 'Platinum', minPoints: 500, pointsMultiplier: 2, discountPercent: 10 },
          ],
          cardPrefix: 'TEST',
          cardDigits: 8,
        }
      }
    });

    expect(configUpdateResponse.statusCode).toBe(200);

    // Create POS order - should use NEW 8% discount (cache should be invalidated)
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        items: [{ productId: product._id, quantity: 1 }],
        branchId: branch._id,
        membershipCardId: customer.membership.cardId,
        payment: { method: 'cash', amount: 920 }, // 1000 - 8% = 920
        deliveryMethod: 'pickup'
      }
    });

    const body = orderResponse.json();
    expect(orderResponse.statusCode).toBe(201);

    // Verify new tier discount was applied (proves cache invalidation worked)
    expect(body.data.membershipApplied.tier).toBe('Silver');
    expect(body.data.membershipApplied.tierDiscountPercent).toBe(8); // New value
    expect(body.data.membershipApplied.tierDiscountApplied).toBe(80); // 8% of 1000
    expect(body.data.discountAmount).toBe(80);
    expect(body.data.totalAmount).toBe(920);
  });

  it('should apply updated tier discount after multiple config changes (cache invalidation)', async () => {
    // Change Silver tier discount to 12% (different from 8% to prove cache refresh)
    const configResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform/config',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        membership: {
          enabled: true,
          pointsPerAmount: 1,
          amountPerPoint: 100,
          roundingMode: 'floor',
          tiers: [
            { name: 'Bronze', minPoints: 0, pointsMultiplier: 1, discountPercent: 0 },
            { name: 'Silver', minPoints: 50, pointsMultiplier: 1.25, discountPercent: 12 }, // Changed to 12%
            { name: 'Gold', minPoints: 200, pointsMultiplier: 1.5, discountPercent: 5 },
            { name: 'Platinum', minPoints: 500, pointsMultiplier: 2, discountPercent: 10 },
          ],
          cardPrefix: 'TEST',
          cardDigits: 8,
        }
      }
    });

    expect(configResponse.statusCode).toBe(200);

    // Create order - should use 12% discount (proves cache was invalidated again)
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        items: [{ productId: product._id, quantity: 1 }],
        branchId: branch._id,
        membershipCardId: customer.membership.cardId,
        payment: { method: 'cash', amount: 880 }, // 1000 - 12% = 880
        deliveryMethod: 'pickup'
      }
    });

    const body = orderResponse.json();
    expect(orderResponse.statusCode).toBe(201);
    expect(body.data.membershipApplied).toBeDefined();
    expect(body.data.membershipApplied.tierDiscountPercent).toBe(12);
    expect(body.data.membershipApplied.tierDiscountApplied).toBe(120);
    expect(body.data.totalAmount).toBe(880);
  });
});
