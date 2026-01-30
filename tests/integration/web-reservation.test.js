// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';

import { StockEntry } from '../../modules/inventory/stock/models/index.js';

vi.mock('#shared/revenue/revenue.plugin.js', async () => {
  const actual = await vi.importActual('#shared/revenue/revenue.plugin.js');
  return {
    ...actual,
    getRevenue: () => ({
      monetization: {
        create: () => {
          throw new Error('Payment init failed');
        },
      },
    }),
  };
});

describe('Web Checkout Stock Reservation', () => {
  let app;
  let userToken;
  let adminToken;
  let userId;
  let branch;
  let product;
  let Cart;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser, createTestBranch, createTestProduct } = await import('../helpers/test-data.js');

    app = await createTestServer();

    const user = await createTestUser(app, { role: 'user' });
    userToken = user.token;
    userId = user.user._id;

    const admin = await createTestUser(app, { role: 'admin' });
    adminToken = admin.token;

    const Branch = mongoose.models.Branch;
    await Branch.deleteMany({ code: 'WEB-RES' });
    branch = await Branch.create(createTestBranch({ code: 'WEB-RES', name: 'Web Reservation Branch', isDefault: true }));

    const Product = mongoose.models.Product;
    const uniqueSlug = `web-reservation-product-${Date.now()}`;
    product = await Product.create(createTestProduct({
      name: 'Web Reservation Product',
      sku: `WEB-RES-${Date.now()}`,
      slug: uniqueSlug,
      basePrice: 0, // free order to avoid payment gateway dependencies
      quantity: 0,
      category: 'test-category',
    }));

    // Upsert stock at this branch (event handlers may create a 0-qty entry)
    await StockEntry.findOneAndUpdate(
      { product: product._id, branch: branch._id, variantSku: null },
      { $set: { quantity: 10, reservedQuantity: 0, isActive: true } },
      { upsert: true, new: true }
    );

    Cart = mongoose.models.Cart;
    await Cart.deleteMany({ user: userId });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should reserve stock on checkout and release on cancel', async () => {
    await Cart.create({
      user: userId,
      items: [{ product: product._id, variantSku: null, quantity: 3 }],
    });

    const checkoutPayload = {
      branchId: branch._id.toString(),
      delivery: { method: 'delivery', price: 0 },
      deliveryAddress: {
        recipientName: 'Test User',
        recipientPhone: '01712345678',
        addressLine1: 'Test Address',
        city: 'Dhaka',
        areaId: 1,
        areaName: 'Test Area',
        zoneId: 1,
        postalCode: '1207',
      },
      paymentData: { type: 'cash' },
      notes: 'reserve test',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { Authorization: `Bearer ${userToken}` },
      payload: checkoutPayload,
    });

    expect(res.statusCode).toBe(201);
    const order = res.json().data;
    expect(order.stockReservationId).toBeDefined();

    const afterCheckout = await StockEntry.findOne({ product: product._id, branch: branch._id, variantSku: null }).lean();
    expect(afterCheckout.quantity).toBe(10);
    expect(afterCheckout.reservedQuantity).toBe(3);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order._id}/cancel`,
      headers: { Authorization: `Bearer ${userToken}` },
      payload: { reason: 'changed mind', refund: false },
    });

    expect(cancelRes.statusCode).toBe(200);

    const afterCancel = await StockEntry.findOne({ product: product._id, branch: branch._id, variantSku: null }).lean();
    expect(afterCancel.quantity).toBe(10);
    expect(afterCancel.reservedQuantity).toBe(0);
  });

  it('should commit reservation on fulfillment (quantity decremented, reserved cleared)', async () => {
    await Cart.deleteMany({ user: userId });
    await Cart.create({
      user: userId,
      items: [{ product: product._id, variantSku: null, quantity: 3 }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { Authorization: `Bearer ${userToken}` },
      payload: {
        branchId: branch._id.toString(),
        delivery: { method: 'delivery', price: 0 },
        deliveryAddress: {
          recipientName: 'Test User',
          recipientPhone: '01712345678',
          addressLine1: 'Test Address',
          city: 'Dhaka',
          areaId: 1,
          areaName: 'Test Area',
          zoneId: 1,
          postalCode: '1207',
        },
        paymentData: { type: 'cash' },
      },
    });

    expect(res.statusCode).toBe(201);
    const order = res.json().data;

    const beforeFulfill = await StockEntry.findOne({ product: product._id, branch: branch._id, variantSku: null }).lean();
    expect(beforeFulfill.quantity).toBe(10);
    expect(beforeFulfill.reservedQuantity).toBe(3);

    const fulfillRes = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order._id}/fulfill`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { branchId: branch._id.toString() },
    });

    expect(fulfillRes.statusCode).toBe(200);

    const afterFulfill = await StockEntry.findOne({ product: product._id, branch: branch._id, variantSku: null }).lean();
    expect(afterFulfill.quantity).toBe(7);
    expect(afterFulfill.reservedQuantity).toBe(0);
  });

  it('should release reservation and cancel order when payment init fails', async () => {
    const Product = mongoose.models.Product;
    const paidProduct = await Product.create({
      name: `Web Reservation Paid ${Date.now()}`,
      sku: `WEB-RES-PAID-${Date.now()}`,
      slug: `web-reservation-paid-${Date.now()}`,
      basePrice: 100,
      quantity: 0,
      category: 'test-category',
    });

    await StockEntry.findOneAndUpdate(
      { product: paidProduct._id, branch: branch._id, variantSku: null },
      { $set: { quantity: 5, reservedQuantity: 0, isActive: true } },
      { upsert: true, new: true }
    );

    await Cart.deleteMany({ user: userId });
    await Cart.create({
      user: userId,
      items: [{ product: paidProduct._id, variantSku: null, quantity: 2 }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { Authorization: `Bearer ${userToken}` },
      payload: {
        branchId: branch._id.toString(),
        delivery: { method: 'delivery', price: 0 },
        deliveryAddress: {
          recipientName: 'Test User',
          recipientPhone: '01712345678',
          addressLine1: 'Test Address',
          city: 'Dhaka',
          areaId: 1,
          areaName: 'Test Area',
          zoneId: 1,
          postalCode: '1207',
        },
        paymentData: { type: 'card', gateway: 'manual' },
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const afterFailure = await StockEntry.findOne({
      product: paidProduct._id,
      branch: branch._id,
      variantSku: null,
    }).lean();
    expect(afterFailure.reservedQuantity).toBe(0);

    const Order = mongoose.models.Order;
    const failedOrder = await Order.findOne({
      userId,
      'items.product': paidProduct._id,
    }).sort({ createdAt: -1 }).lean();
    expect(failedOrder).toBeTruthy();
    expect(failedOrder.status).toBe('cancelled');
    expect(failedOrder.currentPayment?.status).toBe('failed');
  });
});
