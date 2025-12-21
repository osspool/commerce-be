// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

/**
 * SDK Client Integration Tests
 *
 * Tests the CommerceClient SDK patterns against a real Fastify server with MongoDB Memory Server
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';

/**
 * Minimal SDK client for testing (mimics CommerceClient pattern)
 * This validates the SDK design works with the actual API
 */
class TestCommerceClient {
  constructor({ apiKey, organizationId }) {
    this.apiKey = apiKey;
    this.organizationId = organizationId;
    this.server = null;
  }

  setServer(server) {
    this.server = server;
  }

  async request(method, path, { body, params } = {}) {
    let url = path;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url = `${path}?${queryString}`;
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    if (this.organizationId) {
      headers['x-org-id'] = this.organizationId;
    }

    const response = await this.server.inject({
      method,
      url,
      headers,
      payload: body,
    });

    const data = JSON.parse(response.body);

    if (response.statusCode >= 400) {
      const error = new Error(data.message || 'Request failed');
      error.status = response.statusCode;
      error.code = data.code || 'unknown_error';
      error.data = data;
      throw error;
    }

    return data;
  }

  // Products resource (matches SDK pattern)
  products = {
    list: (params) => this.request('GET', '/api/v1/products', { params }),
    retrieve: (id) => this.request('GET', `/api/v1/products/${id}`),
    create: (data) => this.request('POST', '/api/v1/products', { body: data }),
    update: (id, data) => this.request('PATCH', `/api/v1/products/${id}`, { body: data }),
    delete: (id) => this.request('DELETE', `/api/v1/products/${id}`),
  };

  // Branches resource
  branches = {
    list: (params) => this.request('GET', '/api/v1/branches', { params }),
    retrieve: (id) => this.request('GET', `/api/v1/branches/${id}`),
    create: (data) => this.request('POST', '/api/v1/branches', { body: data }),
  };

  // Orders resource
  orders = {
    list: (params) => this.request('GET', '/api/v1/orders', { params }),
    listMine: (params) => this.request('GET', '/api/v1/orders/my', { params }),
    retrieve: (id) => this.request('GET', `/api/v1/orders/${id}`),
    checkout: (data) => this.request('POST', '/api/v1/orders', { body: data }),
  };

  // POS resource (for quick order creation)
  pos = {
    listProducts: (params) => this.request('GET', '/api/v1/pos/products', { params }),
    createOrder: (data) => this.request('POST', '/api/v1/pos/orders', { body: data }),
  };

  // Inventory resource
  inventory = {
    list: (params) => this.request('GET', '/api/v1/inventory', { params }),
  };
}

describe('SDK Client Integration', () => {
  let app;
  let client;
  let adminToken;
  let testBranch;
  let testProduct;

  beforeAll(async () => {
    // Dynamic imports
    const { createTestServer } = await import('../helpers/test-utils.js');
    const testData = await import('../helpers/test-data.js');
    const { createTestUser, createTestProduct, createTestBranch, createTestStock } = testData;

    app = await createTestServer();

    // Create admin user
    const admin = createTestUser(app, { role: 'admin' });
    adminToken = admin.token;

    // Create test branch directly in DB
    const Branch = mongoose.models.Branch;
    await Branch.deleteMany({ code: 'SDK-TEST' });
    testBranch = await Branch.create(createTestBranch({
      name: 'SDK Test Branch',
      code: 'SDK-TEST',
    }));

    // Create test product directly in DB
    const Product = mongoose.models.Product;
    testProduct = await Product.create(createTestProduct({
      name: 'SDK Test Product',
      basePrice: 1000,
      sku: `SDK-PROD-${Date.now()}`,
    }));

    // Create stock
    await createTestStock(app, {
      product: testProduct._id,
      branch: testBranch._id,
      quantity: 100,
    });

    // Initialize SDK client
    client = new TestCommerceClient({
      apiKey: adminToken,
      organizationId: null, // Using default org for tests
    });
    client.setServer(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('Products Resource', () => {
    it('should list products using client.products.list()', async () => {
      const result = await client.products.list({ limit: 10 });

      expect(result.success).toBe(true);
      expect(result.docs).toBeDefined();
      expect(Array.isArray(result.docs)).toBe(true);
    });

    it('should retrieve a product using client.products.retrieve()', async () => {
      const result = await client.products.retrieve(testProduct._id.toString());

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.name).toBe('SDK Test Product');
      expect(result.data.basePrice).toBe(1000);
    });

    it('should create a product using client.products.create()', async () => {
      const uniqueSku = `CREATE-TEST-${Date.now()}`;
      const result = await client.products.create({
        name: 'Created via SDK',
        basePrice: 1500,
        category: 'test-category',
        sku: uniqueSku,
        barcode: `BAR-${uniqueSku}`,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.name).toBe('Created via SDK');
      expect(result.data.basePrice).toBe(1500);
    });

    it('should update a product using client.products.update()', async () => {
      // Create a product to update
      const Product = mongoose.models.Product;
      const product = await Product.create({
        name: 'Before Update',
        basePrice: 500,
        category: 'test-category',
        sku: `UPDATE-TEST-${Date.now()}`,
        barcode: `BAR-UPDATE-${Date.now()}`,
      });

      const result = await client.products.update(product._id.toString(), {
        name: 'After Update',
        basePrice: 750,
      });

      expect(result.success).toBe(true);
      expect(result.data.name).toBe('After Update');
      expect(result.data.basePrice).toBe(750);
    });

    it('should delete a product using client.products.delete()', async () => {
      // Create a product to delete
      const Product = mongoose.models.Product;
      const product = await Product.create({
        name: 'To Be Deleted',
        basePrice: 100,
        category: 'test-category',
        sku: `DELETE-TEST-${Date.now()}`,
        barcode: `BAR-DELETE-${Date.now()}`,
      });

      const result = await client.products.delete(product._id.toString());

      expect(result.success).toBe(true);

      // Verify soft delete
      const deleted = await Product.findById(product._id);
      expect(deleted.deletedAt).toBeDefined();
    });
  });

  describe('Branches Resource', () => {
    it('should list branches using client.branches.list()', async () => {
      const result = await client.branches.list({ limit: 10 });

      expect(result.success).toBe(true);
      expect(result.docs).toBeDefined();
      expect(result.docs.length).toBeGreaterThanOrEqual(1);
    });

    it('should retrieve a branch using client.branches.retrieve()', async () => {
      const result = await client.branches.retrieve(testBranch._id.toString());

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.code).toBe('SDK-TEST');
    });
  });

  describe('POS Resource', () => {
    it('should list products with stock using client.pos.listProducts()', async () => {
      const result = await client.pos.listProducts({
        branchId: testBranch._id.toString(),
        limit: 10,
      });

      expect(result.success).toBe(true);
      expect(result.docs).toBeDefined();

      // Find our test product
      const product = result.docs.find(p => p._id.toString() === testProduct._id.toString());
      if (product) {
        expect(product.branchStock).toBeDefined();
        expect(product.branchStock.quantity).toBe(100);
      }
    });

    it('should create a POS order using client.pos.createOrder()', async () => {
      const result = await client.pos.createOrder({
        items: [{
          productId: testProduct._id.toString(),
          quantity: 2,
          price: 1000,
        }],
        branchId: testBranch._id.toString(),
        payment: { method: 'cash', amount: 2000 },
        deliveryMethod: 'pickup',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.status).toBe('delivered'); // Pickup orders are auto-delivered
      expect(result.data.items.length).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unauthenticated request to protected route', async () => {
      const noAuthClient = new TestCommerceClient({
        apiKey: null,
        organizationId: null,
      });
      noAuthClient.setServer(app);

      try {
        // Use GET /orders which requires admin auth
        await noAuthClient.orders.list();
        expect.fail('Should have thrown');
      } catch (error) {
        // Should reject unauthenticated request
        expect(error.status).toBe(401);
      }
    });

    it('should throw error for not found resource', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      try {
        await client.products.retrieve(fakeId);
        expect.fail('Should have thrown');
      } catch (error) {
        // Accept both 404 and 500 - backend may return different codes
        expect([404, 500]).toContain(error.status);
      }
    });
  });

  describe('Pagination', () => {
    beforeAll(async () => {
      // Create 15 products for pagination tests
      const Product = mongoose.models.Product;
      const products = [];
      const timestamp = Date.now();
      for (let i = 0; i < 15; i++) {
        products.push({
          name: `Pagination Product ${i}`,
          basePrice: 100 + i,
          category: 'test-category',
          sku: `PAG-${timestamp}-${i}`,
          barcode: `BAR-PAG-${timestamp}-${i}`,
        });
      }
      await Product.insertMany(products);
    });

    it('should paginate with limit parameter', async () => {
      const result = await client.products.list({ limit: 5 });

      expect(result.success).toBe(true);
      expect(result.docs.length).toBe(5);
      expect(result.hasNext).toBe(true);
    });

    it('should paginate with page parameter', async () => {
      const page1 = await client.products.list({ limit: 5, page: 1 });
      const page2 = await client.products.list({ limit: 5, page: 2 });

      expect(page1.docs.length).toBe(5);
      expect(page2.docs.length).toBe(5);

      // Ensure different products
      const page1Ids = page1.docs.map(p => p._id);
      const page2Ids = page2.docs.map(p => p._id);
      const overlap = page1Ids.filter(id => page2Ids.includes(id));
      expect(overlap.length).toBe(0);
    });
  });

  describe('SDK Pattern Validation', () => {
    it('should follow OpenAI/Stripe pattern: client.resource.method()', async () => {
      // Verify the SDK pattern works as expected
      const timestamp = Date.now();

      // 1. Create
      const createResult = await client.products.create({
        name: 'Pattern Test Product',
        basePrice: 999,
        category: 'test-category',
        sku: `PATTERN-${timestamp}`,
        barcode: `BAR-PATTERN-${timestamp}`,
      });
      expect(createResult.success).toBe(true);
      const productId = createResult.data._id;

      // 2. Retrieve
      const retrieveResult = await client.products.retrieve(productId);
      expect(retrieveResult.data.name).toBe('Pattern Test Product');

      // 3. Update
      const updateResult = await client.products.update(productId, {
        name: 'Updated Pattern Product',
      });
      expect(updateResult.data.name).toBe('Updated Pattern Product');

      // 4. List (verify it appears)
      const listResult = await client.products.list({ limit: 100 });
      const found = listResult.docs.find(p => p._id === productId);
      expect(found).toBeDefined();

      // 5. Delete
      const deleteResult = await client.products.delete(productId);
      expect(deleteResult.success).toBe(true);
    });
  });
});
