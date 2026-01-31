/**
 * Product Search Tests
 *
 * Tests the regex-based search implementation in ProductRepository
 * that supports partial word matching (unlike MongoDB $text which only matches whole words)
 *
 * Test cases:
 * 1. Partial word search (e.g., "azu" matches "azure")
 * 2. Case-insensitive search
 * 3. Search with other params (limit, select, sort)
 * 4. Search across multiple fields (name, description, sku)
 * 5. Search combined with filters (e.g., isActive=false)
 * 6. Empty/whitespace search returns all products
 */

// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

describe('Product Search', () => {
  let app;
  let Product;
  let adminToken;

  // Test products
  const testProducts = [
    {
      name: 'The Azure Sultan – Royal Blue Karchupi Cotton Panjabi',
      description: 'Premium cotton panjabi with intricate karchupi work',
      basePrice: 2500,
      category: 'panjabi',
      sku: 'AZURE-SULTAN-001',
      tags: ['premium', 'cotton', 'blue'],
      isActive: true,
    },
    {
      name: 'Classic White Shirt',
      description: 'Simple white cotton shirt for everyday wear',
      basePrice: 800,
      category: 'shirt',
      sku: 'WHITE-SHIRT-001',
      tags: ['casual', 'cotton', 'white'],
      isActive: true,
    },
    {
      name: 'Red Premium Polo',
      description: 'High quality polo shirt with azure blue accent',
      basePrice: 1200,
      category: 'polo',
      sku: 'RED-POLO-001',
      tags: ['premium', 'polo'],
      isActive: true,
    },
    {
      name: 'Inactive Test Product',
      description: 'This product is inactive',
      basePrice: 500,
      category: 'test',
      sku: 'INACTIVE-001',
      tags: ['test'],
      isActive: false,
    },
  ];

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser } = await import('../helpers/test-data.js');

    app = await createTestServer();
    Product = mongoose.models.Product;

    // Create admin token
    adminToken = createTestUser(app, {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Admin',
      roles: ['admin'],
    }).token;

    // Clean up any existing test products
    await Product.deleteMany({
      sku: { $in: testProducts.map(p => p.sku) },
    });

    // Create test products
    for (const product of testProducts) {
      await Product.create(product);
    }
  });

  afterAll(async () => {
    // Clean up test products
    await Product.deleteMany({
      sku: { $in: testProducts.map(p => p.sku) },
    });
    if (app) await app.close();
  });

  // ============ Partial Word Matching ============

  describe('partial word matching', () => {
    it('should find product with partial word "azu" matching "Azure"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=azu',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.docs.length).toBeGreaterThanOrEqual(1);

      // Should find "The Azure Sultan" product
      const azureProduct = body.docs.find(p => p.name.includes('Azure'));
      expect(azureProduct).toBeDefined();
    });

    it('should find product with partial word "panjabi"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=panjabi',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.docs.length).toBeGreaterThanOrEqual(1);

      const panjabiProduct = body.docs.find(p => p.name.includes('Panjabi'));
      expect(panjabiProduct).toBeDefined();
    });

    it('should find product with partial word "sult" matching "Sultan"', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=sult',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);

      const sultanProduct = body.docs.find(p => p.name.includes('Sultan'));
      expect(sultanProduct).toBeDefined();
    });
  });

  // ============ Case Insensitive ============

  describe('case insensitive search', () => {
    it('should find products regardless of case', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=AZURE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
    });

    it('should find products with mixed case search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=AzUrE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============ Search with Other Params ============

  describe('search with other parameters', () => {
    it('should respect limit parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=cotton&limit=1',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBe(1);
      expect(body.limit).toBe(1);
    });

    it('should respect select parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=azure&select=name,sku,basePrice',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);

      const product = body.docs[0];
      expect(product.name).toBeDefined();
      expect(product.sku).toBeDefined();
      expect(product.basePrice).toBeDefined();
      // Description should not be selected
      expect(product.description).toBeUndefined();
    });

    it('should respect sort parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=cotton&sort=-basePrice',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Verify descending order by price
      if (body.docs.length >= 2) {
        expect(body.docs[0].basePrice).toBeGreaterThanOrEqual(body.docs[1].basePrice);
      }
    });

    it('should work with pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=cotton&page=1&limit=2',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
      expect(body.docs.length).toBeLessThanOrEqual(2);
    });
  });

  // ============ Multi-field Search ============

  describe('multi-field search', () => {
    it('should search in description field', async () => {
      // "azure blue accent" is in Red Premium Polo's description
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=accent',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);

      const poloProduct = body.docs.find(p => p.name.includes('Polo'));
      expect(poloProduct).toBeDefined();
    });

    it('should search in SKU field', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=SULTAN-001',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
      expect(body.docs[0].sku).toContain('SULTAN');
    });

    it('should search in tags field', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=premium',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Should find products with "premium" tag
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============ Combined with Filters ============

  describe('search combined with filters', () => {
    it('should respect isActive filter with search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=test&isActive=false',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Should find inactive test product
      if (body.docs.length > 0) {
        body.docs.forEach(p => {
          expect(p.isActive).toBe(false);
        });
      }
    });

    it('should respect category filter with search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=cotton&category=shirt',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // All results should be in shirt category
      body.docs.forEach(p => {
        expect(p.category).toBe('shirt');
      });
    });
  });

  // ============ Edge Cases ============

  describe('edge cases', () => {
    it('should handle empty search gracefully', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      // Should return products (empty search = no search filter)
    });

    it('should handle whitespace-only search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=%20%20%20',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
    });

    it('should handle special characters safely', async () => {
      // Test that special regex chars are escaped and don't cause errors
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=test.*+',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
    });

    it('should return empty results for non-matching search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=xyznonexistent123',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.docs.length).toBe(0);
    });
  });

  // ============ Default isActive Filter ============

  describe('default isActive filter behavior', () => {
    it('should only return active products by default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/products?search=test',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Should NOT find inactive product unless explicitly requested
      const inactiveProduct = body.docs.find(p => p.sku === 'INACTIVE-001');
      expect(inactiveProduct).toBeUndefined();
    });
  });
});
