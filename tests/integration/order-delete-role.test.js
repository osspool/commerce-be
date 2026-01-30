/**
 * Order Deletion Role-Based Access Tests
 *
 * Tests the before:delete hook on OrderRepository that:
 * 1. Blocks deletion for non-superadmin users
 * 2. Allows deletion for superadmin users
 * 3. Handles empty JSON bodies gracefully (for Content-Type: application/json without body)
 */

// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

describe('Order Deletion Role-Based Access', () => {
  let app;
  let Order;
  let Customer;
  let Product;
  let Branch;
  let StockEntry;

  // Test data
  let testOrder;
  let testCustomer;
  let testProduct;
  let testBranch;
  let superAdminToken;
  let adminToken;
  let userToken;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser, createTestProduct, createTestBranch, createTestCustomer, createTestOrder } = await import('../helpers/test-data.js');

    app = await createTestServer();

    Order = mongoose.models.Order;
    Customer = mongoose.models.Customer;
    Product = mongoose.models.Product;
    Branch = mongoose.models.Branch;
    StockEntry = mongoose.models.StockEntry;

    // Create test tokens with different roles
    superAdminToken = createTestUser(app, {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Super Admin',
      roles: ['user', 'superadmin', 'admin'],
    }).token;

    adminToken = createTestUser(app, {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Admin User',
      roles: ['user', 'admin'],
    }).token;

    userToken = createTestUser(app, {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Regular User',
      roles: ['user'],
    }).token;

    // Create test branch
    await Branch.deleteMany({ code: 'ORDER-DEL-TEST' });
    testBranch = await Branch.create(createTestBranch({
      name: 'Order Delete Test Branch',
      code: 'ORDER-DEL-TEST',
    }));

    // Create test product
    testProduct = await Product.create(createTestProduct({
      name: 'Order Delete Test Product',
      basePrice: 1000,
      sku: `ORDER-DEL-${Date.now()}`,
    }));

    // Create stock
    await StockEntry.create({
      product: testProduct._id,
      branch: testBranch._id,
      variantSku: null,
      quantity: 100,
      reorderPoint: 10,
      costPrice: 500,
    });

    // Create test customer
    testCustomer = await Customer.create(createTestCustomer({
      name: 'Order Delete Test Customer',
      phone: `DEL${Date.now()}`.slice(-11),
    }));
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Helper to create an order for deletion testing
   */
  async function createOrderForDeletion() {
    const { createTestOrder } = await import('../helpers/test-data.js');
    const orderData = createTestOrder(testCustomer._id, testProduct._id, {
      status: 'pending',
      source: 'web', // Valid enum values: web, pos, api, guest
    });
    return Order.create(orderData);
  }

  // ============ Role-Based Access ============

  describe('role-based deletion access', () => {
    it('should allow superadmin to delete an order', async () => {
      const order = await createOrderForDeletion();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orders/${order._id}`,
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);

      // Verify order is deleted
      const deletedOrder = await Order.findById(order._id);
      expect(deletedOrder).toBeNull();
    });

    it('should block admin (non-superadmin) from deleting an order', async () => {
      const order = await createOrderForDeletion();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orders/${order._id}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      // Should return an error (400 or 500 depending on error handling)
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json();
      expect(body.success).toBe(false);

      // Verify order still exists (the important assertion)
      const existingOrder = await Order.findById(order._id);
      expect(existingOrder).not.toBeNull();
    });

    it('should block regular user from deleting an order', async () => {
      const order = await createOrderForDeletion();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orders/${order._id}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      // Should be blocked by either permission or the hook
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json();
      expect(body.success).toBe(false);

      // Verify order still exists
      const existingOrder = await Order.findById(order._id);
      expect(existingOrder).not.toBeNull();
    });
  });

  // ============ Empty JSON Body Handling ============

  describe('empty JSON body handling', () => {
    it('should accept DELETE with Content-Type: application/json but no body', async () => {
      const order = await createOrderForDeletion();

      // This tests the fix for FST_ERR_CTP_EMPTY_JSON_BODY
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orders/${order._id}`,
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'application/json',
        },
        // No payload - empty body
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
    });

    it('should accept DELETE with Content-Type: application/json and empty string body', async () => {
      const order = await createOrderForDeletion();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orders/${order._id}`,
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'application/json',
        },
        payload: '', // Empty string
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
    });

    it('should still reject invalid JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'application/json',
        },
        payload: '{ invalid json }',
      });

      // Should return an error for invalid JSON (400 or 500)
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  // ============ GET with Content-Type ============

  describe('GET requests with Content-Type: application/json', () => {
    it('should accept GET with Content-Type header and empty body', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/orders',
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          'Content-Type': 'application/json',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
    });
  });
});
