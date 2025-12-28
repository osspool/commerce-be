// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import StockMovement from '../../modules/commerce/inventory/stockMovement.model.js';
import Transfer from '../../modules/commerce/inventory/transfer/transfer.model.js';
import Branch from '../../modules/commerce/branch/branch.model.js';
import productRepository from '../../modules/commerce/product/product.repository.js';

/**
 * Product Deletion & Audit Trail Tests
 *
 * These tests verify:
 * 1. Hard delete does NOT cascade to StockEntry/StockMovement (preserves audit trail)
 * 2. CSV exports work correctly for movements and transfers
 * 3. Historical data remains accessible after product deletion
 */
describe('Product Deletion & Audit Trail', () => {
  let app;
  let adminToken;
  let testProduct;
  let testBranch;
  let testStockEntry;
  let testMovements = [];
  let testTransfer;
  let adminUser;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser } = await import('../helpers/test-data.js');

    app = await createTestServer();

    // Create admin user and get token
    const adminResult = await createTestUser(app, { role: 'admin' });
    adminToken = adminResult.token;
    adminUser = adminResult.user;

    // Create test branch
    testBranch = await Branch.create({
      code: 'TEST-DEL-BR',
      name: 'Test Delete Branch',
      role: 'head_office',
      address: { city: 'Dhaka', country: 'BD' },
    });

    // Create test product
    testProduct = await Product.create({
      name: 'Test Product for Deletion',
      category: 'test-category',
      basePrice: 1000,
      sku: 'TEST-DEL-SKU',
    });

    // Create stock entry
    testStockEntry = await StockEntry.create({
      product: testProduct._id,
      branch: testBranch._id,
      variantSku: null,
      quantity: 100,
      reorderPoint: 10,
    });

    // Create stock movements
    const movementTypes = ['initial', 'sale', 'adjustment', 'return'];
    for (const type of movementTypes) {
      const movement = await StockMovement.create({
        stockEntry: testStockEntry._id,
        product: testProduct._id,
        branch: testBranch._id,
        type,
        quantity: type === 'sale' ? -10 : 10,
        balanceAfter: 100,
        notes: `Test ${type} movement`,
      });
      testMovements.push(movement);
    }

    // Create a transfer
    testTransfer = await Transfer.create({
      challanNumber: 'TEST-DEL-CHN-001',
      senderBranch: testBranch._id,
      receiverBranch: testBranch._id,
      status: 'completed',
      items: [{
        product: testProduct._id,
        productName: testProduct.name,
        productSku: testProduct.sku,
        quantity: 10,
        quantityReceived: 10,
      }],
      createdBy: adminUser._id,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('Cascade Deletion Prevention', () => {
    it('should NOT delete StockEntry when product is hard deleted', async () => {
      // Verify stock entry exists before deletion
      const entryBefore = await StockEntry.findById(testStockEntry._id);
      expect(entryBefore).toBeTruthy();
      expect(entryBefore.product.toString()).toBe(testProduct._id.toString());

      // Hard delete the product
      await productRepository.hardDelete(testProduct._id);

      // Verify product is deleted
      const deletedProduct = await Product.findById(testProduct._id);
      expect(deletedProduct).toBeNull();

      // Verify stock entry still exists (NOT deleted)
      const entryAfter = await StockEntry.findById(testStockEntry._id);
      expect(entryAfter).toBeTruthy();
      expect(entryAfter.product.toString()).toBe(testProduct._id.toString());
      expect(entryAfter.quantity).toBe(100);
    });

    it('should NOT delete StockMovements when product is hard deleted', async () => {
      // Verify movements exist and reference the deleted product
      const movements = await StockMovement.find({ product: testProduct._id });
      expect(movements.length).toBe(testMovements.length);
      expect(movements.length).toBeGreaterThan(0);

      // Verify each movement type is preserved
      const types = movements.map(m => m.type).sort();
      expect(types).toContain('initial');
      expect(types).toContain('sale');
      expect(types).toContain('adjustment');
      expect(types).toContain('return');
    });

    it('should NOT delete Transfers when product is hard deleted', async () => {
      // Verify transfer still exists
      const transfer = await Transfer.findById(testTransfer._id);
      expect(transfer).toBeTruthy();
      expect(transfer.items[0].product.toString()).toBe(testProduct._id.toString());
      expect(transfer.items[0].productName).toBe('Test Product for Deletion');
    });

    it('should preserve audit trail integrity after deletion', async () => {
      // Verify we can still query movements for deleted products
      const movements = await StockMovement.find({ product: testProduct._id })
        .sort({ createdAt: -1 })
        .lean();

      expect(movements.length).toBeGreaterThan(0);
      movements.forEach(movement => {
        expect(movement.product.toString()).toBe(testProduct._id.toString());
        expect(movement.balanceAfter).toBeDefined();
        expect(movement.type).toBeDefined();
      });
    });
  });

  describe('CSV Export - Stock Movements', () => {
    it('should export stock movements to CSV format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?branchId=${testBranch._id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('stock-movements-');

      const csv = response.body;
      expect(csv).toBeTruthy();
      expect(typeof csv).toBe('string');

      // Verify CSV header
      const lines = csv.split('\n');
      expect(lines[0]).toContain('Movement ID');
      expect(lines[0]).toContain('Date');
      expect(lines[0]).toContain('Type');
      expect(lines[0]).toContain('Product ID');
      expect(lines[0]).toContain('Quantity Change');

      // Verify data rows exist
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should filter movements by product in export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?productId=${testProduct._id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;
      const lines = csv.split('\n');

      // Should include header + data rows for this product
      expect(lines.length).toBeGreaterThan(1);

      // Verify product ID appears in the CSV
      const hasProductId = lines.some(line => line.includes(testProduct._id.toString()));
      expect(hasProductId).toBe(true);
    });

    it('should filter movements by type in export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?type=sale`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;

      // Verify CSV contains sale movements
      expect(csv).toContain('sale');
    });

    it('should respect limit parameter in export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?limit=2`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;
      const lines = csv.split('\n').filter(line => line.trim());

      // Header + max 2 data rows = max 3 lines
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    it('should handle CSV special characters properly', async () => {
      // Create movement with special characters in notes
      const specialMovement = await StockMovement.create({
        stockEntry: testStockEntry._id,
        product: testProduct._id,
        branch: testBranch._id,
        type: 'adjustment',
        quantity: 5,
        balanceAfter: 105,
        notes: 'Test with "quotes" and, commas',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?productId=${testProduct._id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;

      // Verify quotes are properly escaped (doubled)
      expect(csv).toContain('""quotes""');

      await StockMovement.deleteOne({ _id: specialMovement._id });
    });
  });

  describe('CSV Export - Transfers', () => {
    it('should export transfers to CSV format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('transfers-');

      const csv = response.body;
      expect(csv).toBeTruthy();
      expect(typeof csv).toBe('string');

      // Verify CSV header
      const lines = csv.split('\n');
      expect(lines[0]).toContain('Transfer ID');
      expect(lines[0]).toContain('Challan Number');
      expect(lines[0]).toContain('Status');
      expect(lines[0]).toContain('Sender Branch');
      expect(lines[0]).toContain('Receiver Branch');

      // Verify data rows exist
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should filter transfers by status in export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export?status=completed',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;

      // Verify CSV contains completed status
      expect(csv).toContain('completed');
    });

    it('should export transfer even after product deletion', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;

      // Verify transfer with deleted product is still in export
      expect(csv).toContain(testTransfer.challanNumber);
      expect(csv).toContain('Test Product for Deletion');
    });

    it('should respect limit parameter in transfers export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export?limit=1',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;
      const lines = csv.split('\n').filter(line => line.trim());

      // Header + max 1 data row = max 2 lines
      expect(lines.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Authorization for Export', () => {
    it('should require authentication for movements export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/movements/export',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require authentication for transfers export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Export Data Integrity', () => {
    it('should preserve all movement data fields in CSV export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/inventory/movements/export?productId=${testProduct._id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;
      const lines = csv.split('\n');

      // Verify header has all required fields
      const header = lines[0];
      expect(header).toContain('Movement ID');
      expect(header).toContain('Date');
      expect(header).toContain('Type');
      expect(header).toContain('Product ID');
      expect(header).toContain('Product Name');
      expect(header).toContain('Variant SKU');
      expect(header).toContain('Branch ID');
      expect(header).toContain('Quantity Change');
      expect(header).toContain('Balance After');
      expect(header).toContain('Cost Per Unit');
      expect(header).toContain('Reference Model');
      expect(header).toContain('Notes');
    });

    it('should preserve all transfer data fields in CSV export', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory/transfers/export?limit=1',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const csv = response.body;
      const lines = csv.split('\n');

      // Verify header has all required fields
      const header = lines[0];
      expect(header).toContain('Transfer ID');
      expect(header).toContain('Challan Number');
      expect(header).toContain('Transfer Type');
      expect(header).toContain('Status');
      expect(header).toContain('Sender Branch');
      expect(header).toContain('Receiver Branch');
      expect(header).toContain('Total Items');
      expect(header).toContain('Total Quantity');
      expect(header).toContain('Total Value');
      expect(header).toContain('Created At');
      expect(header).toContain('Approved At');
      expect(header).toContain('Dispatched At');
      expect(header).toContain('Received At');
      expect(header).toContain('Vehicle Number');
      expect(header).toContain('Remarks');
    });
  });
});
