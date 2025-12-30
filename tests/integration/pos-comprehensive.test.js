// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Product from '#modules/catalog/products/product.model.js';
import Customer from '#modules/sales/customers/customer.model.js';
import Category from '#modules/catalog/categories/category.model.js';
import Branch from '#modules/commerce/branch/branch.model.js';
import PlatformConfig from '#modules/platform/platform.model.js';

/**
 * Comprehensive POS Integration Tests
 *
 * Tests:
 * - VAT calculation (product/category/platform levels)
 * - Manual discounts
 * - Membership tier discounts
 * - Points redemption
 * - Receipt generation (both from create response and dedicated API)
 * - Platform payment method integration
 */
describe('POS Comprehensive Features', () => {
  let app;
  let adminToken;
  let branch;
  let productWithVat;
  let productNoVat;
  let memberCustomer;
  let cashier;

  beforeAll(async () => {
    // Dynamic import to ensure env vars are set before config loads
    const { createTestServer } = await import('../helpers/test-utils.js');
    const testData = await import('../helpers/test-data.js');
    const { createTestUser, createTestStock } = testData;

    app = await createTestServer();
    const admin = await createTestUser(app, { role: 'admin' });
    adminToken = admin.token;
    cashier = admin.user;

    // Create category with VAT
    const vatCategory = await Category.findOneAndUpdate(
      { slug: 'electronics' },
      {
        name: 'Electronics',
        slug: 'electronics',
        vatRate: 15, // Product VAT rate field (not vat.rate)
      },
      { upsert: true, new: true }
    );

    // Product with VAT (15% rate set directly on product)
    productWithVat = await Product.create(
      testData.createTestProduct({
        name: 'Smart Watch',
        basePrice: 1000,
        category: 'electronics',
        sku: `WATCH-${Date.now()}`,
        vatRate: 15, // Set VAT rate directly on product
      })
    );

    // Product without VAT
    productNoVat = await Product.create(
      testData.createTestProduct({
        name: 'T-Shirt',
        basePrice: 500,
        category: 'clothing',
        sku: `SHIRT-${Date.now()}`,
      })
    );

    // Setup: Create Branch
    await Branch.deleteMany({ code: 'DHK' });
    branch = await Branch.create(
      testData.createTestBranch({
        name: 'Dhaka Branch',
        code: 'DHK',
        address: { city: 'Dhaka' },
      })
    );

    // Setup: Add Stock
    await createTestStock(app, {
      product: productWithVat._id,
      branch: branch._id,
      quantity: 100,
    });
    await createTestStock(app, {
      product: productNoVat._id,
      branch: branch._id,
      quantity: 100,
    });

    // Setup: Create member customer with points
    memberCustomer = await Customer.create({
      name: 'Gold Member',
      phone: '01700000001',
      email: 'gold@test.com',
      membership: {
        isActive: true,
        tier: 'gold',
        cardId: `MBR-${Date.now()}`,
        points: {
          current: 1000,
          lifetime: 5000,
        },
        joinedAt: new Date(),
      },
    });

    // Setup: Configure platform with membership settings
    await PlatformConfig.findOneAndUpdate(
      {},
      {
        $set: {
          membership: {
            enabled: true,
            tiers: [
              {
                name: 'silver',
                discountPercent: 5,
                minimumSpend: 0,
              },
              {
                name: 'gold',
                discountPercent: 10,
                minimumSpend: 10000,
              },
              {
                name: 'platinum',
                discountPercent: 15,
                minimumSpend: 50000,
              },
            ],
            // Points earning: 1 point per 1 BDT
            amountPerPoint: 1,
            pointsPerAmount: 1,
            minimumPurchase: 100,
            roundingMode: 'floor',
            // Points redemption: 10 points = 1 BDT
            redemption: {
              enabled: true,
              pointsPerBdt: 10,
              minimumPoints: 100,
              maximumPercentOfOrder: 50,
            },
          },
          vat: {
            isRegistered: true,
            bin: '1234567890123',
            pricesIncludeVat: true,
            defaultRate: 5,
            invoice: {
              showVatBreakdown: true,
            },
          },
        },
      },
      { upsert: true, new: true }
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should calculate VAT correctly on products', async () => {
    // Product has vatRate: 15 set at creation time
    const orderPayload = {
      items: [
        {
          productId: productWithVat._id,
          quantity: 1,
          price: 1000,
        },
      ],
      branchId: branch._id,
      payment: { method: 'cash', amount: 1000 },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    // Verify VAT is applied (rate may be from product, category, or platform default)
    expect(order.vat.applicable).toBe(true);
    expect(order.vat.rate).toBeGreaterThan(0); // VAT rate is configured
    expect(order.vat.amount).toBeGreaterThan(0);
    expect(order.vat.invoiceNumber).toBeDefined();
    expect(order.vat.sellerBin).toBe('1234567890123');
    expect(order.vat.taxableAmount).toBeDefined();
    expect(order.vat.pricesIncludeVat).toBe(true);
  });

  it('should apply manual discount correctly', async () => {
    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 2,
          price: 500,
        },
      ],
      branchId: branch._id,
      discount: 200, // Manual discount
      payment: { method: 'cash', amount: 800 },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    expect(order.subtotal).toBe(1000); // 2 * 500
    expect(order.discountAmount).toBe(200);
    expect(order.totalAmount).toBe(800); // 1000 - 200
  });

  it('should apply membership tier discount automatically', async () => {
    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 2,
          price: 500,
        },
      ],
      branchId: branch._id,
      membershipCardId: memberCustomer.membership.cardId, // Gold member (10% discount)
      payment: { method: 'cash' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    expect(order.subtotal).toBe(1000); // 2 * 500
    expect(order.membershipApplied).toBeDefined();
    expect(order.membershipApplied.tier).toBe('gold');
    expect(order.membershipApplied.tierDiscountPercent).toBe(10);
    expect(order.membershipApplied.tierDiscountApplied).toBe(100); // 10% of 1000
    expect(order.totalAmount).toBe(900); // 1000 - 100
  });

  it('should redeem loyalty points correctly', async () => {
    // Reset customer state to known values for this test
    await Customer.findByIdAndUpdate(memberCustomer._id, {
      'membership.points.current': 1000,
      'membership.tier': 'gold',
    });

    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 2,
          price: 500,
        },
      ],
      branchId: branch._id,
      membershipCardId: memberCustomer.membership.cardId,
      pointsToRedeem: 500, // 500 points = 50 BDT discount (10 points per BDT)
      payment: { method: 'cash' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    expect(order.subtotal).toBe(1000);
    expect(order.membershipApplied.tierDiscountApplied).toBe(100); // 10% tier discount
    expect(order.membershipApplied.pointsRedeemed).toBe(500);
    expect(order.membershipApplied.pointsRedemptionDiscount).toBe(50); // 500 points / 10
    expect(order.totalAmount).toBe(850); // 1000 - 100 (tier) - 50 (points)

    // Verify points balance:
    // Initial: 1000, Redeemed: 500, Earned: 850 (from 850 BDT order with 1:1 ratio)
    // Final: 1000 - 500 + 850 = 1350
    const updatedCustomer = await Customer.findById(memberCustomer._id);
    expect(updatedCustomer.membership.points.current).toBe(1350);
  });

  it('should cap points redemption at maximum allowed', async () => {
    // Reset customer state for this test
    await Customer.findByIdAndUpdate(memberCustomer._id, {
      'membership.points.current': 5000,
      'membership.tier': 'gold',
    });

    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 1,
          price: 500,
        },
      ],
      branchId: branch._id,
      membershipCardId: memberCustomer.membership.cardId,
      pointsToRedeem: 3000, // Request 3000 points = 300 BDT
      // Order: 500 - 50 (tier) = 450 BDT
      // Max redemption: 50% of 450 = 225 BDT = 2250 points
      // System should CAP to 2250 points (not reject)
      payment: { method: 'cash' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    // System caps over-redemption rather than rejecting
    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    // Order totals:
    // Subtotal: 500
    // Tier discount: 50 (10%)
    // Preliminary: 450
    // Max redemption: 225 BDT = 2250 points (capped from 3000)
    // Final: 450 - 225 = 225
    expect(order.membershipApplied.pointsRedeemed).toBe(2250); // Capped
    expect(order.membershipApplied.pointsRedemptionDiscount).toBe(225);
    expect(order.totalAmount).toBe(225);
  });

  it('should combine manual discount, tier discount, and points redemption', async () => {
    // Reset customer state for this test
    await Customer.findByIdAndUpdate(memberCustomer._id, {
      'membership.points.current': 1000,
      'membership.tier': 'gold',
    });

    const orderPayload = {
      items: [
        {
          productId: productNoVat._id, // Use product without VAT for simpler calculation
          quantity: 2,
          price: 500,
        },
      ],
      branchId: branch._id,
      discount: 100, // Manual discount
      membershipCardId: memberCustomer.membership.cardId, // Gold: 10% tier discount
      pointsToRedeem: 200, // 200 points = 20 BDT
      payment: { method: 'cash' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    expect(order.subtotal).toBe(1000); // 2 * 500
    expect(order.membershipApplied.tierDiscountApplied).toBe(100); // 10% tier discount
    expect(order.membershipApplied.pointsRedeemed).toBe(200);
    expect(order.membershipApplied.pointsRedemptionDiscount).toBe(20); // 200 points / 10
    // Total discount = 100 (manual) + 100 (10% tier) + 20 (points) = 220
    expect(order.discountAmount).toBe(220);
    expect(order.totalAmount).toBe(780); // 1000 - 220
  });

  it('should include receipt data in order creation response', async () => {
    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 1,
          price: 500,
        },
      ],
      branchId: branch._id,
      payment: { method: 'bkash', amount: 500, reference: 'TRX12345' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    // Verify all data needed for receipt is present in create response
    expect(order._id).toBeDefined();
    expect(order.items).toBeDefined();
    expect(order.items.length).toBe(1);
    expect(order.subtotal).toBe(500);
    expect(order.totalAmount).toBe(500);
    expect(order.currentPayment).toBeDefined();
    expect(order.currentPayment.method).toBe('bkash');
    expect(order.currentPayment.reference).toBe('TRX12345');
    expect(order.vat).toBeDefined();
    expect(order.customerName).toBeDefined();

    // Frontend can render receipt directly from this response
    // No need for separate API call
  });

  it('should fetch receipt from dedicated endpoint', async () => {
    // First create an order
    const orderPayload = {
      items: [
        {
          productId: productWithVat._id,
          quantity: 1,
          price: 1000,
        },
      ],
      branchId: branch._id,
      payments: [
        { method: 'cash', amount: 300 },
        { method: 'bkash', amount: 700, reference: 'TRX-SPLIT-99' },
      ],
      deliveryMethod: 'pickup',
    };

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(createResponse.statusCode).toBe(201);
    const order = createResponse.json().data;

    // Now fetch receipt via dedicated endpoint
    const receiptResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pos/orders/${order._id}/receipt`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(receiptResponse.statusCode).toBe(200);
    const receipt = receiptResponse.json().data;

    // Verify receipt structure
    expect(receipt.orderId).toBe(order._id);
    expect(receipt.orderNumber).toBeDefined();
    expect(receipt.date).toBeDefined();
    expect(receipt.branch).toBeDefined();
    expect(receipt.cashier).toBeDefined();
    expect(receipt.items).toHaveLength(1);
    expect(receipt.subtotal).toBe(1000);
    expect(receipt.total).toBe(1000);
    expect(receipt.vat.applicable).toBe(true);

    // Verify split payment breakdown
    expect(receipt.payment.method).toBe('split');
    expect(receipt.payment.payments).toHaveLength(2);
    expect(receipt.payment.payments[0].method).toBe('cash');
    expect(receipt.payment.payments[0].amount).toBe(300);
    expect(receipt.payment.payments[1].method).toBe('bkash');
    expect(receipt.payment.payments[1].amount).toBe(700);
    expect(receipt.payment.payments[1].reference).toBe('TRX-SPLIT-99');
  });

  it('should validate split payments total matches order total', async () => {
    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 1,
          price: 500,
        },
      ],
      branchId: branch._id,
      payments: [
        { method: 'cash', amount: 200 },
        { method: 'bkash', amount: 200 }, // Total 400, but order is 500
      ],
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toMatch(/does not match/i);
  });

  it('should earn points on purchase', async () => {
    // Reset customer state for this test
    await Customer.findByIdAndUpdate(memberCustomer._id, {
      'membership.points.current': 1000,
      'membership.tier': 'gold',
    });

    const orderPayload = {
      items: [
        {
          productId: productNoVat._id,
          quantity: 2,
          price: 500,
        },
      ],
      branchId: branch._id,
      membershipCardId: memberCustomer.membership.cardId,
      payment: { method: 'cash' },
      deliveryMethod: 'pickup',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: orderPayload,
    });

    expect(response.statusCode).toBe(201);
    const order = response.json().data;

    // Points earned calculation:
    // Subtotal: 1000
    // Tier discount: 100 (10%)
    // Final amount: 900
    // Points: 900 * 1 point/BDT = 900 points
    expect(order.membershipApplied.pointsEarned).toBe(900);
  });
});
