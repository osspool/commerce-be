/**
 * Inventory Service Integration Tests
 *
 * Tests for Fix #1 & #2:
 * - Repository events are emitted after batch operations
 * - Barcode cache invalidation works correctly
 * - Product sync retries on failure
 * - Low-stock and out-of-stock events fire
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import inventoryService from '../../modules/commerce/inventory/inventory.service.js';
import inventoryRepository from '../../modules/commerce/inventory/inventory.repository.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import Branch from '../../modules/commerce/branch/branch.model.js';
import {
  createTestProduct,
  createTestBranch,
  createTestStockEntry,
  createTestProductWithVariants
} from '../helpers/test-data.js';
import { createEventSpy, waitFor, sleep, captureConsole } from '../helpers/test-utils.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('Inventory Service - Event Emissions & Cache', () => {
  let product;
  let branch;
  let stockEntry;

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
    // Create test data
    branch = await Branch.create(createTestBranch());
    product = await Product.create(createTestProduct());
    stockEntry = await StockEntry.create(createTestStockEntry(product._id, branch._id, {
      quantity: 50,
      reorderPoint: 10,
      barcode: '1234567890',
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
        { model: 'Order', id: 'order-123' },
        'user-123'
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

    it('should emit low-stock event when quantity drops below reorderPoint', async () => {
      // Create stock entry with quantity above reorder point
      await StockEntry.updateOne(
        { _id: stockEntry._id },
        { quantity: 12, reorderPoint: 10 }
      );

      // Spy on low-stock event
      const lowStockPromise = createEventSpy(inventoryRepository, 'low-stock');

      // Decrement to trigger low-stock
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 5 }],
        branch._id
      );

      const lowStockEvent = await lowStockPromise;
      expect(lowStockEvent).toBeDefined();
      expect(lowStockEvent.currentQuantity).toBe(7); // 12 - 5 = 7
      expect(lowStockEvent.reorderPoint).toBe(10);
    });

    it('should emit out-of-stock event when quantity reaches 0', async () => {
      // Set quantity to 5
      await StockEntry.updateOne(
        { _id: stockEntry._id },
        { quantity: 5 }
      );

      // Spy on out-of-stock event
      const outOfStockPromise = createEventSpy(inventoryRepository, 'out-of-stock');

      // Decrement to zero
      await inventoryService.decrementBatch(
        [{ productId: product._id, variantSku: null, quantity: 5 }],
        branch._id
      );

      const outOfStockEvent = await outOfStockPromise;
      expect(outOfStockEvent).toBeDefined();
      expect(outOfStockEvent.product.toString()).toBe(product._id.toString());
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
        { model: 'Order', id: 'order-123' },
        'user-123'
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

  describe('Product Sync with Retry Logic', () => {
    it('should retry product sync on failure', async () => {
      const console = captureConsole();

      // Temporarily break syncProduct by using invalid product ID
      const invalidProductId = new mongoose.Types.ObjectId();

      // This should trigger retries
      await inventoryService._syncWithRetry(invalidProductId);

      // Wait for retries to complete
      await sleep(5000); // Total: 1s + 2s + 4s = 7s, but we'll wait 5s

      // Should see retry logs
      const errorLogs = console.logs.error.flat().join(' ');
      expect(errorLogs).toContain('attempt 1');

      console.restore();
    });

    it('should log critical error after all retries fail', async () => {
      const console = captureConsole();

      // Use invalid product ID
      const invalidProductId = new mongoose.Types.ObjectId();

      // Reduce retries for faster test
      inventoryService.syncRetries = 2;
      inventoryService.syncRetryDelay = 100;

      await inventoryService._syncWithRetry(invalidProductId);

      // Wait for all retries
      await sleep(500);

      // Should see CRITICAL error
      const errorLogs = console.logs.error.flat().join(' ');
      expect(errorLogs).toContain('CRITICAL');
      expect(errorLogs).toContain('Failed to sync product');

      // Restore
      inventoryService.syncRetries = 3;
      inventoryService.syncRetryDelay = 1000;
      console.restore();
    });

    it('should successfully sync product quantity on first try', async () => {
      // Create product with variant
      const variantProduct = await Product.create(createTestProductWithVariants());

      // Create stock entries for variants
      await StockEntry.create({
        product: variantProduct._id,
        branch: branch._id,
        variantSku: 'VAR-S',
        quantity: 50,
      });

      await StockEntry.create({
        product: variantProduct._id,
        branch: branch._id,
        variantSku: 'VAR-M',
        quantity: 30,
      });

      // Sync product
      await inventoryService._syncWithRetry(variantProduct._id);

      // Wait a bit for sync to complete
      await sleep(100);

      // Check product quantity was synced
      const updated = await Product.findById(variantProduct._id);
      expect(updated.quantity).toBe(80); // 50 + 30
    });
  });

  describe('Variant Products - Quantity Sync', () => {
    it('should sync variant product quantity correctly', async () => {
      const variantProduct = await Product.create(createTestProductWithVariants());

      // Create stock entries
      await StockEntry.create({
        product: variantProduct._id,
        branch: branch._id,
        variantSku: 'VAR-S',
        quantity: 100,
      });

      await StockEntry.create({
        product: variantProduct._id,
        branch: branch._id,
        variantSku: 'VAR-M',
        quantity: 50,
      });

      await StockEntry.create({
        product: variantProduct._id,
        branch: branch._id,
        variantSku: 'VAR-L',
        quantity: 25,
      });

      // Decrement variant stock
      await inventoryService.decrementBatch(
        [
          { productId: variantProduct._id, variantSku: 'VAR-S', quantity: 10 },
          { productId: variantProduct._id, variantSku: 'VAR-M', quantity: 5 },
        ],
        branch._id
      );

      // Wait for sync
      await sleep(500);

      // Check total quantity
      const updated = await Product.findById(variantProduct._id);
      expect(updated.quantity).toBe(160); // (100-10) + (50-5) + 25 = 160
    });
  });
});
