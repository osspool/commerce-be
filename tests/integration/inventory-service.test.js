/**
 * Inventory Service Integration Tests
 *
 * Tests:
 * - Repository events are emitted after batch operations
 * - Barcode cache invalidation works correctly
 * - Batch decrement and restore operations work atomically
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import inventoryService from '../../modules/commerce/inventory/inventory.service.js';
import inventoryRepository from '../../modules/commerce/inventory/inventory.repository.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import Branch from '../../modules/commerce/branch/branch.model.js';
import stockService from '../../modules/commerce/core/services/stock.service.js';
import StockReservation from '../../modules/commerce/core/models/stockReservation.model.js';
import {
  createTestProduct,
  createTestBranch,
  createTestStockEntry,
} from '../helpers/test-data.js';
import { createEventSpy } from '../helpers/test-utils.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

// Helper to create valid ObjectIds for tests
const createObjectId = () => new mongoose.Types.ObjectId();

describe('Inventory Service - Event Emissions & Cache', () => {
  let product;
  let branch;
  let stockEntry;
  let testOrderId;
  let testUserId;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Clear collections
    await Branch.deleteMany({});
    await Product.deleteMany({});
    await StockEntry.deleteMany({});
    await StockReservation.deleteMany({});
    // Create valid ObjectIds for references
    testOrderId = createObjectId();
    testUserId = createObjectId();
    // Create test data
    branch = await Branch.create(createTestBranch());
    product = await Product.create(createTestProduct({ barcode: '1234567890' }));
    stockEntry = await StockEntry.create(createTestStockEntry(product._id, branch._id, {
      quantity: 50,
      reorderPoint: 10,
    }));
  });

  describe('decrementBatch - Event Emissions', () => {
    it('should emit after:update events for each decremented item', async () => {
      // Spy on repository events
      const eventPromise = createEventSpy(inventoryRepository, 'after:update');

      // Decrement stock
      const result = await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 5, productName: product.name }],
        branch._id,
        { model: 'Order', id: testOrderId },
        testUserId
      );

      expect(result.success).toBe(true);
      expect(result.decrementedItems).toHaveLength(1);

      // Wait for event to fire
      const eventData = await eventPromise;
      expect(eventData).toBeDefined();
      expect(eventData.context.quantityDelta).toBe(-5);
      expect(eventData.context.previousQuantity).toBe(50);
    });

    it('should invalidate barcode cache after decrement', async () => {
      // First, populate cache by looking up
      const cached1 = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(cached1.quantity).toBe(50);

      // Decrement stock
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 10 }],
        branch._id
      );

      // Lookup again - should see updated quantity (cache invalidated)
      const cached2 = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(cached2.quantity).toBe(40);
    });

    it('should lookup by product SKU and invalidate SKU cache after decrement', async () => {
      // Populate cache via product-level SKU (common for POS typing/scanning)
      const cached1 = await inventoryRepository.getByBarcodeOrSku(product.sku, branch._id);
      expect(cached1.quantity).toBe(50);

      // Decrement stock
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 7 }],
        branch._id
      );

      // Lookup again - should see updated quantity (SKU cache invalidated)
      const cached2 = await inventoryRepository.getByBarcodeOrSku(product.sku, branch._id);
      expect(cached2.quantity).toBe(43);
    });
  });

  describe('Stock Reservations - Cache Invalidation', () => {
    it('should invalidate barcode cache when reservedQuantity changes', async () => {
      // Prime cache
      const cached1 = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(cached1.reservedQuantity || 0).toBe(0);

      // Reserve stock (reservedQuantity increments)
      await stockService.reserve(
        'res-test-1',
        [{ productId: product._id, variantSku: null, quantity: 3, productName: product.name }],
        branch._id
      );

      const cached2 = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(cached2.reservedQuantity).toBe(3);

      // Release stock (reservedQuantity decrements)
      await stockService.release('res-test-1');

      const cached3 = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(cached3.reservedQuantity || 0).toBe(0);
    });
  });

  describe('restoreBatch - Event Emissions', () => {
    it('should emit after:update events for each restored item', async () => {
      // Decrement first
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 20 }],
        branch._id
      );

      // Spy on event
      const eventPromise = createEventSpy(inventoryRepository, 'after:update');

      // Restore stock
      const result = await inventoryService.restoreBatch(
        [{ productId: product._id, variantSku: null, quantity: 20 }],
        branch._id,
        { model: 'Order', id: testOrderId },
        testUserId
      );

      expect(result.success).toBe(true);

      // Wait for event
      const eventData = await eventPromise;
      expect(eventData.context.quantityDelta).toBe(20);
    });

    it('should invalidate barcode cache after restore', async () => {
      // Decrement first
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 20 }],
        branch._id
      );

      // Check quantity
      let entry = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(entry.quantity).toBe(30);

      // Restore
      await inventoryService.restoreBatch(
        [{ productId: product._id, variantSku: null, quantity: 20 }],
        branch._id
      );

      // Cache should be invalidated
      entry = await inventoryRepository.getByBarcodeOrSku('1234567890', branch._id);
      expect(entry.quantity).toBe(50);
    });
  });

  describe('Batch Operations - Atomicity', () => {
    it('should decrement multiple items atomically', async () => {
      // Create second product
      const product2 = await Product.create(createTestProduct({ name: 'Product 2' }));
      await StockEntry.create(createTestStockEntry(product2._id, branch._id, {
        quantity: 100,
      }));

      // Decrement both
      const result = await inventoryService.decrementBatch(
        [
          { productId: product._id, variantSku: null, quantity: 10 },
          { productId: product2._id, variantSku: null, quantity: 25 },
        ],
        branch._id,
        { model: 'Order', id: testOrderId },
        testUserId
      );

      expect(result.success).toBe(true);
      expect(result.decrementedItems).toHaveLength(2);

      // Verify quantities
      const entry1 = await StockEntry.findOne({ product: product._id, branch: branch._id });
      const entry2 = await StockEntry.findOne({ product: product2._id, branch: branch._id });
      expect(entry1.quantity).toBe(40); // 50 - 10
      expect(entry2.quantity).toBe(75); // 100 - 25
    });

    it('should fail entire batch if one item has insufficient stock', async () => {
      // Create product with low stock
      const lowStockProduct = await Product.create(createTestProduct({ name: 'Low Stock Product' }));
      await StockEntry.create(createTestStockEntry(lowStockProduct._id, branch._id, {
        quantity: 5,
      }));

      const result = await inventoryService.decrementBatch(
        [
          { productId: product._id, variantSku: null, quantity: 10 },
          { productId: lowStockProduct._id, variantSku: null, quantity: 50 }, // More than available
        ],
        branch._id
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient stock');
    });

    it('should check availability without modifying stock', async () => {
      const result = await inventoryService.checkAvailability(
        [
          { productId: product._id, variantSku: null, quantity: 10 },
          { productId: product._id, variantSku: null, quantity: 100 }, // More than available
        ],
        branch._id
      );

      expect(result.available).toBe(false);
      expect(result.unavailableItems).toHaveLength(1);
      expect(result.unavailableItems[0].shortage).toBe(50); // 100 - 50 = 50 short

      // Stock should be unchanged
      const entry = await StockEntry.findOne({ product: product._id, branch: branch._id });
      expect(entry.quantity).toBe(50);
    });
  });
});
