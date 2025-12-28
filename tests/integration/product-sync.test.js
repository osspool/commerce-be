// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import productRepository from '../../modules/commerce/product/product.repository.js';

describe('Product Stock Sync', () => {
  let app;
  let adminToken;
  let headOffice;
  let subBranch;
  let product;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser } = await import('../helpers/test-data.js');

    app = await createTestServer();
    adminToken = (await createTestUser(app, { role: 'admin' })).token;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await Promise.all([
      StockEntry.deleteMany({}),
      Product.deleteMany({}),
      Branch.deleteMany({}),
    ]);

    const { createTestBranch, createTestProduct } = await import('../helpers/test-data.js');

    headOffice = await Branch.create(createTestBranch({
      code: 'HO',
      name: 'Head Office',
      role: 'head_office',
      type: 'warehouse',
      isDefault: true,
    }));

    subBranch = await Branch.create(createTestBranch({
      code: 'SUB1',
      name: 'Sub Branch 1',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    product = await Product.create(createTestProduct({
      quantity: 0,
      costPrice: 500,
    }));

    await StockEntry.create({
      product: product._id,
      branch: headOffice._id,
      variantSku: null,
      quantity: 5,
      costPrice: 500,
      isActive: true,
    });

    await StockEntry.create({
      product: product._id,
      branch: subBranch._id,
      variantSku: null,
      quantity: 7,
      costPrice: 520,
      isActive: true,
    });
  });

  it('syncs product.quantity from StockEntry totals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${product._id}/sync-stock`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.totalQuantity).toBe(12);

    const refreshed = await Product.findById(product._id).lean();
    expect(refreshed.quantity).toBe(12);
    expect(refreshed.costPrice).toBe(500);
  });

  it('syncs variant stock projection from StockEntry totals', async () => {
    const variantProduct = await productRepository.create({
      name: 'Variant Sync Product',
      basePrice: 1200,
      category: 'test-category',
      variationAttributes: [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Color', values: ['Red'] },
      ],
    });

    const [smallVariant, mediumVariant] = variantProduct.variants;

    await StockEntry.updateOne(
      { product: variantProduct._id, branch: headOffice._id, variantSku: smallVariant.sku },
      { $set: { quantity: 3, isActive: true } },
      { upsert: true }
    );

    await StockEntry.updateOne(
      { product: variantProduct._id, branch: subBranch._id, variantSku: smallVariant.sku },
      { $set: { quantity: 5, isActive: true } },
      { upsert: true }
    );

    await StockEntry.updateOne(
      { product: variantProduct._id, branch: headOffice._id, variantSku: mediumVariant.sku },
      { $set: { quantity: 2, isActive: true } },
      { upsert: true }
    );

    await StockEntry.updateOne(
      { product: variantProduct._id, branch: subBranch._id, variantSku: mediumVariant.sku },
      { $set: { quantity: 4, isActive: true } },
      { upsert: true }
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${variantProduct._id}/sync-stock`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.totalQuantity).toBe(14);

    const refreshed = await Product.findById(variantProduct._id).lean();
    expect(refreshed.quantity).toBe(14);
    expect(refreshed.stockProjection?.variants?.length).toBe(2);

    const bySku = new Map(refreshed.stockProjection.variants.map(v => [v.sku, v.quantity]));
    expect(bySku.get(smallVariant.sku)).toBe(8);
    expect(bySku.get(mediumVariant.sku)).toBe(6);
  });
});
