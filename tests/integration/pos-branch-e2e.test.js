// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/catalog/products/product.model.js';
import { StockEntry } from '../../modules/inventory/stock/models/index.js';
import Order from '../../modules/sales/orders/order.model.js';
import Transaction from '../../modules/transaction/transaction.model.js';
import Customer from '../../modules/sales/customers/customer.model.js';

describe('POS + Branch E2E', () => {
  let app;
  let adminToken;
  let storeToken;
  let defaultBranch;
  let secondBranch;
  let product;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser } = await import('../helpers/test-data.js');

    app = await createTestServer();
    adminToken = (await createTestUser(app, { role: 'admin' })).token;
    storeToken = (await createTestUser(app, { role: 'store-manager' })).token;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await Promise.all([
      StockEntry.deleteMany({}),
      Order.deleteMany({}),
      Transaction.deleteMany({}),
      Customer.deleteMany({}),
      Product.deleteMany({}),
      Branch.deleteMany({}),
    ]);

    const { createTestBranch, createTestProduct, createTestStockEntry } = await import('../helpers/test-data.js');

    defaultBranch = await Branch.create(createTestBranch({
      code: 'HO',
      name: 'Head Office',
      role: 'head_office',
      type: 'warehouse',
      isDefault: true,
    }));

    secondBranch = await Branch.create(createTestBranch({
      code: 'DHK',
      name: 'Dhaka Store',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    product = await Product.create(createTestProduct({
      name: 'POS Item',
      basePrice: 500,
    }));

    await StockEntry.create(createTestStockEntry(product._id, defaultBranch._id, {
      quantity: 20,
      costPrice: 250,
    }));

    await StockEntry.create(createTestStockEntry(product._id, secondBranch._id, {
      quantity: 5,
      costPrice: 260,
    }));
  });

  it('allows store staff to browse POS catalog and lookup stock', async () => {
    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pos/products?branchId=${defaultBranch._id}&limit=10`,
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json();
    const item = listBody.docs.find(p => p?.sku === product.sku);
    expect(item).toBeTruthy();
    expect(item.branchStock.quantity).toBe(20);

    const lookupResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pos/lookup?code=${product.sku}&branchId=${defaultBranch._id}`,
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(lookupResponse.statusCode).toBe(200);
    const lookupBody = lookupResponse.json();
    expect(lookupBody.data.quantity).toBe(20);
    expect(String(lookupBody.data.branchId)).toBe(String(defaultBranch._id));
  });

  it('creates a POS pickup order and generates a receipt', async () => {
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/orders',
      headers: { Authorization: `Bearer ${storeToken}` },
      payload: {
        branchId: defaultBranch._id,
        deliveryMethod: 'pickup',
        payment: { method: 'cash', amount: 1000 },
        items: [{ productId: product._id, quantity: 2 }],
      },
    });

    expect(orderResponse.statusCode).toBe(201);
    const orderBody = orderResponse.json();
    const orderId = orderBody.data?._id;
    expect(orderId).toBeTruthy();
    expect(orderBody.data.status).toBe('delivered');

    const stock = await StockEntry.findOne({ product: product._id, branch: defaultBranch._id });
    expect(stock.quantity).toBe(18);

    const receiptResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pos/orders/${orderId}/receipt`,
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(receiptResponse.statusCode).toBe(200);
    const receiptBody = receiptResponse.json();
    expect(String(receiptBody.data.orderId)).toBe(String(orderId));
  });

  it('allows store staff to adjust stock via POS stock endpoint', async () => {
    const adjustResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pos/stock/adjust',
      headers: { Authorization: `Bearer ${storeToken}` },
      payload: {
        productId: product._id.toString(),
        branchId: secondBranch._id.toString(),
        quantity: 2,
        mode: 'remove',
        reason: 'damaged',
      },
    });

    expect(adjustResponse.statusCode).toBe(200);
    const stock = await StockEntry.findOne({ product: product._id, branch: secondBranch._id });
    expect(stock.quantity).toBe(3);
  });

  it('supports branch CRUD and default branch management', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/branches',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        code: 'CTG',
        name: 'Chattogram Store',
        type: 'store',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data;
    expect(created.code).toBe('CTG');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/branches?limit=10',
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json();
    expect(listBody.docs.some(branch => branch.code === 'CTG')).toBe(true);

    const codeResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/branches/code/CTG',
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(codeResponse.statusCode).toBe(200);
    expect(codeResponse.json().data.code).toBe('CTG');

    const setDefaultResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/branches/${created._id}/set-default`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(setDefaultResponse.statusCode).toBe(200);

    const defaultResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/branches/default',
      headers: { Authorization: `Bearer ${storeToken}` },
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json().data.code).toBe('CTG');
  });
});
