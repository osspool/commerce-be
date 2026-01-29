// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

describe('Guest Checkout', () => {
  let app;
  let Product;
  let Branch;
  let StockEntry;
  let Customer;
  let Order;

  // Test data
  let product;
  let variantProduct;
  let branch;

  const GUEST_URL = '/api/v1/orders/guest';

  const deliveryAddress = {
    recipientName: 'Guest Buyer',
    recipientPhone: '01712345678',
    addressLine1: 'House 12, Road 5',
    areaId: 1,
    areaName: 'Mohammadpur',
    zoneId: 1,
    city: 'Dhaka',
  };

  const delivery = { method: 'standard', price: 80 };

  function buildPayload(overrides = {}) {
    return {
      items: [{ productId: product._id.toString(), quantity: 1 }],
      guest: { name: 'Guest User', phone: '01811111111' },
      deliveryAddress,
      delivery,
      paymentData: { type: 'cash' },
      ...overrides,
    };
  }

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestProduct, createTestBranch } = await import('../helpers/test-data.js');

    app = await createTestServer();

    Product = mongoose.models.Product;
    Branch = mongoose.models.Branch;
    StockEntry = mongoose.models.StockEntry;
    Customer = mongoose.models.Customer;
    Order = mongoose.models.Order;

    // Create branch
    await Branch.deleteMany({ code: 'GUEST-TEST' });
    branch = await Branch.create(createTestBranch({
      name: 'Guest Test Branch',
      code: 'GUEST-TEST',
    }));

    // Create simple product
    product = await Product.create(createTestProduct({
      name: 'Guest Test Product',
      basePrice: 1000,
      sku: `GUEST-SIMPLE-${Date.now()}`,
    }));

    // Create stock for simple product
    await StockEntry.create({
      product: product._id,
      branch: branch._id,
      variantSku: null,
      quantity: 50,
      reorderPoint: 5,
      costPrice: 500,
    });

    // Create variant product
    const uniqueSku = `GUEST-VAR-${Date.now()}`;
    variantProduct = await Product.create({
      name: 'Guest Variant Product',
      basePrice: 500,
      quantity: 0,
      category: 'test-category',
      isActive: true,
      sku: uniqueSku,
      productType: 'variant',
      variationAttributes: [
        { name: 'size', values: ['S', 'M', 'XL'] },
      ],
      variants: [
        { sku: `${uniqueSku}-S`, attributes: new Map([['size', 'S']]), priceModifier: 0, isActive: true },
        { sku: `${uniqueSku}-M`, attributes: new Map([['size', 'M']]), priceModifier: 50, isActive: true },
        { sku: `${uniqueSku}-INACTIVE`, attributes: new Map([['size', 'XL']]), priceModifier: 100, isActive: false },
      ],
    });

    // Create stock for variants
    await StockEntry.create({
      product: variantProduct._id,
      branch: branch._id,
      variantSku: `${uniqueSku}-S`,
      quantity: 20,
      reorderPoint: 5,
      costPrice: 250,
    });
    await StockEntry.create({
      product: variantProduct._id,
      branch: branch._id,
      variantSku: `${uniqueSku}-M`,
      quantity: 20,
      reorderPoint: 5,
      costPrice: 275,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ============ Happy Path ============

  describe('successful guest checkout', () => {
    it('should create order for a simple product without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload(),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.source).toBe('guest');
      expect(body.data.userId).toBeFalsy();
      expect(body.data.customerName).toBe('Guest User');
      expect(body.data.customerPhone).toBe('01811111111');
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].productName).toBe('Guest Test Product');
      expect(body.data.items[0].price).toBe(1000);
      expect(body.data.status).toBe('pending');
      expect(body.meta.message).toBe('Order created successfully');
    });

    it('should create order with variant product', async () => {
      const variantSku = variantProduct.variants[1].sku; // M size, +50

      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [{
            productId: variantProduct._id.toString(),
            variantSku,
            quantity: 2,
          }],
          guest: { name: 'Variant Buyer', phone: '01822222222' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const order = res.json().data;
      expect(order.items).toHaveLength(1);
      expect(order.items[0].variantSku).toBe(variantSku);
      // Price = basePrice(500) + priceModifier(50) = 550
      expect(order.items[0].price).toBe(550);
    });

    it('should create order with multiple items', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [
            { productId: product._id.toString(), quantity: 2 },
            { productId: variantProduct._id.toString(), variantSku: variantProduct.variants[0].sku, quantity: 1 },
          ],
          guest: { name: 'Multi Buyer', phone: '01833333333' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const order = res.json().data;
      expect(order.items).toHaveLength(2);
    });

    it('should strip cost price fields from response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          guest: { name: 'Cost Check', phone: '01844444444' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const order = res.json().data;
      for (const item of order.items) {
        expect(item.costPriceAtSale).toBeUndefined();
        expect(item.profit).toBeUndefined();
        expect(item.profitMargin).toBeUndefined();
      }
    });
  });

  // ============ Customer Resolution ============

  describe('guest customer creation', () => {
    it('should create a new customer record from guest info', async () => {
      const phone = '01855555555';
      await Customer.deleteMany({ phone });

      await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          guest: { name: 'New Guest', phone, email: 'newguest@example.com' },
        }),
      });

      const customer = await Customer.findOne({ phone }).lean();
      expect(customer).toBeDefined();
      expect(customer.name).toBe('New Guest');
      expect(customer.email).toBe('newguest@example.com');
      expect(customer.userId).toBeFalsy();
    });

    it('should reuse existing customer on repeat guest checkout (same phone)', async () => {
      const phone = '01866666666';
      await Customer.deleteMany({ phone });

      // First order
      await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({ guest: { name: 'Repeat Guest', phone } }),
      });

      const firstCustomer = await Customer.findOne({ phone }).lean();

      // Second order — same phone
      await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({ guest: { name: 'Repeat Guest', phone } }),
      });

      const customers = await Customer.find({ phone }).lean();
      expect(customers).toHaveLength(1);
      expect(customers[0]._id.toString()).toBe(firstCustomer._id.toString());
    });
  });

  // ============ Idempotency ============

  describe('idempotency', () => {
    it('should return cached order on retry with same idempotency key', async () => {
      const idempotencyKey = `guest-idem-${Date.now()}`;

      const res1 = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          idempotencyKey,
          guest: { name: 'Idem Guest', phone: '01877777777' },
        }),
      });
      expect(res1.statusCode).toBe(201);
      const order1 = res1.json().data;

      // Retry with same key
      const res2 = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          idempotencyKey,
          guest: { name: 'Idem Guest', phone: '01877777777' },
        }),
      });
      expect(res2.statusCode).toBe(200);
      const body2 = res2.json();
      expect(body2.data._id).toBe(order1._id);
      expect(body2.meta.cached).toBe(true);
    });
  });

  // ============ Validation ============

  describe('validation errors', () => {
    it('should reject empty items array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({ items: [] }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject missing guest info', async () => {
      const payload = buildPayload();
      delete payload.guest;

      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload,
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid phone format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          guest: { name: 'Bad Phone', phone: '12345' },
        }),
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject missing delivery address', async () => {
      const payload = buildPayload();
      delete payload.deliveryAddress;

      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload,
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject nonexistent product ID', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [{ productId: fakeId, quantity: 1 }],
          guest: { name: 'Bad Product', phone: '01888888888' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/not found/i);
    });

    it('should reject invalid variant SKU', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [{
            productId: variantProduct._id.toString(),
            variantSku: 'NONEXISTENT-SKU',
            quantity: 1,
          }],
          guest: { name: 'Bad Variant', phone: '01899999999' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/variant/i);
    });

    it('should reject inactive variant', async () => {
      const inactiveVariant = variantProduct.variants.find(v => v.isActive === false);

      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [{
            productId: variantProduct._id.toString(),
            variantSku: inactiveVariant.sku,
            quantity: 1,
          }],
          guest: { name: 'Inactive Variant', phone: '01800000001' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/not available/i);
    });
  });

  // ============ Order Data Integrity ============

  describe('order data integrity', () => {
    it('should store order with source=guest and no userId in DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          guest: { name: 'DB Check', phone: '01800000002' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const orderId = res.json().data._id;

      const order = await Order.findById(orderId).lean();
      expect(order.source).toBe('guest');
      expect(order.userId).toBeNull();
      expect(order.customer).toBeDefined();
      expect(order.customerName).toBe('DB Check');
      expect(order.customerPhone).toBe('01800000002');
    });

    it('should use DB prices (not client-submitted)', async () => {
      // Product basePrice is 1000 — verify the order uses that, not anything from client
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          items: [{ productId: product._id.toString(), quantity: 3 }],
          guest: { name: 'Price Check', phone: '01800000003' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const order = res.json().data;
      expect(order.items[0].price).toBe(1000);
      expect(order.subtotal).toBe(3000); // 1000 * 3
      expect(order.deliveryCharge).toBe(80);
      expect(order.totalAmount).toBe(3080); // 3000 + 80 delivery
    });

    it('should create stock reservation for guest order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        payload: buildPayload({
          guest: { name: 'Stock Check', phone: '01800000004' },
        }),
      });

      expect(res.statusCode).toBe(201);
      const order = res.json().data;
      expect(order.stockReservationId).toBeDefined();
    });
  });

  // ============ No Auth Required ============

  describe('public access', () => {
    it('should NOT require Authorization header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: GUEST_URL,
        // No headers at all
        payload: buildPayload({
          guest: { name: 'No Auth', phone: '01800000005' },
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().success).toBe(true);
    });
  });
});
