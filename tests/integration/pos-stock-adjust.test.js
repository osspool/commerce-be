/**
 * POS Stock Adjustment Test
 *
 * Tests stock adjustment through service layer (simpler, faster)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Product from '../../modules/catalog/products/product.model.js';
import Branch from '../../modules/commerce/branch/branch.model.js';
import { StockEntry } from '../../modules/inventory/stock/models/index.js';
import { stockSyncService } from '../../modules/inventory/services/index.js';
import { createTestBranch } from '../helpers/test-data.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('POS Stock Adjustment (Service Layer)', () => {
  let branch;
  let simpleProduct;
  let variantProduct;

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

    // Create test branch
    branch = await Branch.create(createTestBranch({ code: 'TEST', name: 'Test Branch', isDefault: true }));

    // Create simple product
    simpleProduct = await Product.create({
      name: 'Simple Product',
      slug: 'simple-product',
      sku: 'SIMPLE-001',
      basePrice: 100,
      category: 'test',
      productType: 'simple',
      isActive: true,
    });

    // Create variant product (mimicking BUTTERCHIC)
    variantProduct = await Product.create({
      name: 'Butter Chicken',
      slug: 'butter-chicken',
      sku: 'BUTTERCHIC',
      basePrice: 500,
      category: 'food',
      productType: 'variant',
      variationAttributes: [
        { name: 'Color', values: ['OLIVE', 'BLACK'] },
        { name: 'Size', values: ['S', 'M', 'L'] },
      ],
      variants: [
        { sku: 'BUTTERCHIC-OLIVE-S', attributes: { color: 'OLIVE', size: 'S' }, priceModifier: 0, isActive: true },
        { sku: 'BUTTERCHIC-OLIVE-M', attributes: { color: 'OLIVE', size: 'M' }, priceModifier: 10, isActive: true },
        { sku: 'BUTTERCHIC-BLACK-S', attributes: { color: 'BLACK', size: 'S' }, priceModifier: 0, isActive: true },
      ],
      isActive: true,
    });
  });

  describe('Simple Product Stock Adjustment', () => {
    it('should set stock for simple product', async () => {
      // Set stock to 50
      const result = await stockSyncService.setStock(
        simpleProduct._id.toString(),
        null, // no variantSku for simple products
        branch._id.toString(),
        50,
        'Initial stock',
        null
      );

      expect(result).toBeDefined();
      expect(result.quantity).toBe(50);

      // Verify in database
      const stockEntry = await StockEntry.findOne({
        product: simpleProduct._id,
        variantSku: null,
        branch: branch._id,
      });

      expect(stockEntry).toBeDefined();
      expect(stockEntry.quantity).toBe(50);
      console.log('✅ Simple product stock set to 50');
    });

    it('should update existing simple product stock', async () => {
      // First set to 30
      await stockSyncService.setStock(
        simpleProduct._id.toString(),
        null,
        branch._id.toString(),
        30,
        'Initial stock',
        null
      );

      // Then update to 75
      const result = await stockSyncService.setStock(
        simpleProduct._id.toString(),
        null,
        branch._id.toString(),
        75,
        'Updated stock',
        null
      );

      expect(result.quantity).toBe(75);

      // Verify in database
      const stockEntry = await StockEntry.findOne({
        product: simpleProduct._id,
        variantSku: null,
        branch: branch._id,
      });

      expect(stockEntry.quantity).toBe(75);
      console.log('✅ Simple product stock updated to 75');
    });
  });

  describe('Variant Product Stock Adjustment - USER SCENARIO', () => {
    it('should set stock for BUTTERCHIC-OLIVE-S (exact user scenario)', async () => {
      // This is exactly what the user is trying to do
      const productId = variantProduct._id.toString();
      const variantSku = 'BUTTERCHIC-OLIVE-S';
      const branchId = branch._id.toString();
      const quantity = 20;

      console.log('\n=== TESTING EXACT USER SCENARIO ===');
      console.log('ProductId:', productId);
      console.log('VariantSku:', variantSku);
      console.log('BranchId:', branchId);
      console.log('Quantity:', quantity);

      // Set stock
      const result = await stockSyncService.setStock(
        productId,
        variantSku,
        branchId,
        quantity,
        'Initial stock for BUTTERCHIC-OLIVE-S',
        null
      );

      console.log('Result:', result);

      expect(result).toBeDefined();
      expect(result.quantity).toBe(20);
      expect(result.variantSku).toBe(variantSku);

      // Verify in database
      const stockEntry = await StockEntry.findOne({
        product: variantProduct._id,
        variantSku: 'BUTTERCHIC-OLIVE-S',
        branch: branch._id,
      });

      console.log('Stock Entry in DB:', {
        _id: stockEntry?._id,
        product: stockEntry?.product,
        variantSku: stockEntry?.variantSku,
        quantity: stockEntry?.quantity,
        branch: stockEntry?.branch,
      });

      expect(stockEntry).toBeDefined();
      expect(stockEntry.quantity).toBe(20);
      expect(stockEntry.variantSku).toBe('BUTTERCHIC-OLIVE-S');

      console.log('✅ Stock for BUTTERCHIC-OLIVE-S set to 20 - THIS SHOULD WORK!');
    });

    it('should update existing variant stock', async () => {
      // First set to 10
      await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-OLIVE-S',
        branch._id.toString(),
        10,
        'Initial stock',
        null
      );

      // Then update to 25
      const result = await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-OLIVE-S',
        branch._id.toString(),
        25,
        'Updated stock',
        null
      );

      expect(result.quantity).toBe(25);

      // Verify in database
      const stockEntry = await StockEntry.findOne({
        product: variantProduct._id,
        variantSku: 'BUTTERCHIC-OLIVE-S',
        branch: branch._id,
      });

      expect(stockEntry.quantity).toBe(25);
      console.log('✅ Variant stock updated to 25');
    });

    it('should handle multiple variants independently', async () => {
      // Set stock for variant 1
      await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-OLIVE-S',
        branch._id.toString(),
        10,
        'Stock for S',
        null
      );

      // Set stock for variant 2
      await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-OLIVE-M',
        branch._id.toString(),
        15,
        'Stock for M',
        null
      );

      // Set stock for variant 3
      await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-BLACK-S',
        branch._id.toString(),
        20,
        'Stock for BLACK-S',
        null
      );

      // Verify all three entries exist
      const entries = await StockEntry.find({
        product: variantProduct._id,
        branch: branch._id,
      });

      expect(entries).toHaveLength(3);

      const oliveS = entries.find(e => e.variantSku === 'BUTTERCHIC-OLIVE-S');
      const oliveM = entries.find(e => e.variantSku === 'BUTTERCHIC-OLIVE-M');
      const blackS = entries.find(e => e.variantSku === 'BUTTERCHIC-BLACK-S');

      expect(oliveS.quantity).toBe(10);
      expect(oliveM.quantity).toBe(15);
      expect(blackS.quantity).toBe(20);

      console.log('✅ Multiple variants handled independently');
    });
  });

  describe('Edge Cases', () => {
    it('should create stock entry if none exists', async () => {
      // Verify no entry exists
      let stockEntry = await StockEntry.findOne({
        product: variantProduct._id,
        variantSku: 'BUTTERCHIC-OLIVE-S',
        branch: branch._id,
      });

      expect(stockEntry).toBeNull();

      // Set stock (should create new entry)
      await stockSyncService.setStock(
        variantProduct._id.toString(),
        'BUTTERCHIC-OLIVE-S',
        branch._id.toString(),
        30,
        'Creating new entry',
        null
      );

      // Verify entry was created
      stockEntry = await StockEntry.findOne({
        product: variantProduct._id,
        variantSku: 'BUTTERCHIC-OLIVE-S',
        branch: branch._id,
      });

      expect(stockEntry).toBeDefined();
      expect(stockEntry.quantity).toBe(30);
      console.log('✅ New stock entry created');
    });

    it('should handle quantity 0', async () => {
      await stockSyncService.setStock(
        simpleProduct._id.toString(),
        null,
        branch._id.toString(),
        0,
        'Out of stock',
        null
      );

      const stockEntry = await StockEntry.findOne({
        product: simpleProduct._id,
        variantSku: null,
        branch: branch._id,
      });

      expect(stockEntry.quantity).toBe(0);
      console.log('✅ Zero quantity handled');
    });
  });
});
