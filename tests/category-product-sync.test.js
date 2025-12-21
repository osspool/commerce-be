/**
 * Category-Product Synchronization Tests
 *
 * Tests the integration between Category and Product modules:
 * - Category product count increments on product create
 * - Category product count decrements on product delete
 * - Category product count updates on product category change
 * - Slug-based reference integrity
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Set required environment variables
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-123456789';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-key-1234567890123456';

// Import models and repositories after setting env
import Category from '#modules/commerce/category/category.model.js';
import Product from '#modules/commerce/product/product.model.js';
import categoryRepository from '#modules/commerce/category/category.repository.js';
import productRepository from '#modules/commerce/product/product.repository.js';

let mongoServer;

describe('Category-Product Synchronization', () => {
    beforeAll(async () => {
        // Start MongoDB Memory Server
        mongoServer = await MongoMemoryServer.create({
            instance: { dbName: 'test-category-sync' },
        });

        const uri = mongoServer.getUri();

        // Connect to in-memory database
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        await mongoose.connect(uri);

        console.log(`\n✓ MongoDB Memory Server started for Category-Product tests\n`);
    });

    afterAll(async () => {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        if (mongoServer) {
            await mongoServer.stop();
            console.log('\n✓ MongoDB Memory Server stopped\n');
        }
    });

    beforeEach(async () => {
        // Clear collections before each test
        await Category.deleteMany({});
        await Product.deleteMany({});
    });

    // ===========================================
    // CATEGORY MODEL TESTS
    // ===========================================

    describe('Category Model', () => {
        it('should create a category with auto-generated slug', async () => {
            const category = await Category.create({
                name: 'T-Shirts',
                description: 'Cool t-shirts',
            });

            expect(category).toBeDefined();
            expect(category.name).toBe('T-Shirts');
            expect(category.slug).toBe('t-shirts');
            expect(category.productCount).toBe(0);
            expect(category.isActive).toBe(true);
        });

        it('should enforce unique slugs', async () => {
            await Category.create({ name: 'T-Shirts' });

            // Second category with same name should get a different slug
            const category2 = await Category.create({ name: 'T-Shirts' });
            expect(category2.slug).not.toBe('t-shirts');
            expect(category2.slug).toMatch(/t-shirts-/); // Should have suffix
        });

        it('should support parent-child hierarchy', async () => {
            const parent = await Category.create({ name: 'Clothing' });
            const child = await Category.create({
                name: 'T-Shirts',
                parent: parent.slug,
            });

            expect(child.parent).toBe('clothing');
            expect(parent.isRoot).toBe(true);
            expect(child.isRoot).toBe(false);
        });
    });

    // ===========================================
    // CATEGORY REPOSITORY TESTS
    // ===========================================

    describe('Category Repository', () => {
        it('should get category by slug', async () => {
            await Category.create({ name: 'Hoodies', displayOrder: 1 });

            const result = await categoryRepository.getBySlug('hoodies');

            expect(result).toBeDefined();
            expect(result.name).toBe('Hoodies');
        });

        it('should build category tree', async () => {
            // Create hierarchy: Clothing -> T-Shirts, Pants
            await Category.create({ name: 'Clothing', displayOrder: 1 });
            await Category.create({ name: 'T-Shirts', parent: 'clothing', displayOrder: 1 });
            await Category.create({ name: 'Pants', parent: 'clothing', displayOrder: 2 });
            await Category.create({ name: 'Accessories', displayOrder: 2 });

            const tree = await categoryRepository.getCategoryTree();

            expect(tree).toHaveLength(2); // Clothing, Accessories

            const clothing = tree.find(c => c.slug === 'clothing');
            expect(clothing).toBeDefined();
            expect(clothing.children).toHaveLength(2);
            expect(clothing.children[0].slug).toBe('t-shirts');
        });

        it('should get flat list with depth', async () => {
            await Category.create({ name: 'Clothing', displayOrder: 1 });
            await Category.create({ name: 'T-Shirts', parent: 'clothing', displayOrder: 1 });

            const flat = await categoryRepository.getFlatList();

            expect(flat).toHaveLength(2);
            expect(flat[0].depth).toBe(0);
            expect(flat[1].depth).toBe(1);
            expect(flat[1].displayName).toContain('T-Shirts');
        });

        it('should update product count', async () => {
            const category = await Category.create({ name: 'Shoes' });
            expect(category.productCount).toBe(0);

            await categoryRepository.updateProductCount('shoes', 1);

            const updated = await Category.findById(category._id);
            expect(updated.productCount).toBe(1);

            await categoryRepository.updateProductCount('shoes', -1);

            const final = await Category.findById(category._id);
            expect(final.productCount).toBe(0);
        });
    });

    // ===========================================
    // PRODUCT-CATEGORY SYNC TESTS
    // ===========================================

    describe('Product-Category Sync', () => {
        it('should reference category by slug in product', async () => {
            await Category.create({ name: 'Electronics' });

            const product = await Product.create({
                name: 'Smartphone',
                category: 'electronics',
                basePrice: 50000,
            });

            expect(product.category).toBe('electronics');

            // Can query products by category slug directly (no aggregation)
            const products = await Product.find({ category: 'electronics' });
            expect(products).toHaveLength(1);
            expect(products[0].name).toBe('Smartphone');
        });

        it('should increment category count on product create (via repository)', async () => {
            const category = await Category.create({ name: 'Laptops' });
            expect(category.productCount).toBe(0);

            // Create product via repository (triggers events)
            await productRepository.create({
                name: 'MacBook Pro',
                category: 'laptops',
                basePrice: 150000,
            });

            // Give event time to process
            await new Promise(r => setTimeout(r, 100));

            const updated = await Category.findById(category._id);
            expect(updated.productCount).toBe(1);
        });

        it('should update category counts on product category change (via repository)', async () => {
            const cat1 = await Category.create({ name: 'Category One' });
            const cat2 = await Category.create({ name: 'Category Two' });

            // Create product in cat1
            const product = await productRepository.create({
                name: 'Test Product',
                category: 'category-one',
                basePrice: 1000,
            });

            await new Promise(r => setTimeout(r, 100));

            let updatedCat1 = await Category.findById(cat1._id);
            expect(updatedCat1.productCount).toBe(1);

            // Move product to cat2
            await productRepository.update(product._id, { category: 'category-two' });

            await new Promise(r => setTimeout(r, 100));

            updatedCat1 = await Category.findById(cat1._id);
            const updatedCat2 = await Category.findById(cat2._id);

            expect(updatedCat1.productCount).toBe(0);
            expect(updatedCat2.productCount).toBe(1);
        });

        it('should decrement category count on product delete (via repository)', async () => {
            const category = await Category.create({ name: 'Tablets' });

            const product = await productRepository.create({
                name: 'iPad Pro',
                category: 'tablets',
                basePrice: 80000,
            });

            await new Promise(r => setTimeout(r, 200));

            let updated = await Category.findById(category._id);
            expect(updated.productCount).toBe(1);

            // Delete product (soft delete via plugin)
            await productRepository.delete(product._id);

            await new Promise(r => setTimeout(r, 200));

            updated = await Category.findById(category._id);
            expect(updated.productCount).toBe(0);
        });

        it('should filter products by category with simple query', async () => {
            await Category.create({ name: 'Shirts' });
            await Category.create({ name: 'Pants' });

            await Product.create({ name: 'Blue Shirt', category: 'shirts', basePrice: 500 });
            await Product.create({ name: 'Red Shirt', category: 'shirts', basePrice: 600 });
            await Product.create({ name: 'Jeans', category: 'pants', basePrice: 1000 });

            // Simple query - no aggregation needed
            const shirts = await Product.find({ category: 'shirts' });
            const pants = await Product.find({ category: 'pants' });

            expect(shirts).toHaveLength(2);
            expect(pants).toHaveLength(1);
        });
    });

    // ===========================================
    // SOFT DELETE TESTS
    // ===========================================

    describe('Product Soft Delete', () => {
        it('should soft delete product (sets deletedAt)', async () => {
            const product = await productRepository.create({
                name: 'Soft Delete Test',
                category: 'test',
                basePrice: 100,
            });

            expect(product.deletedAt).toBeNull();

            await productRepository.delete(product._id);

            // Product should have deletedAt set
            const deleted = await Product.findById(product._id);
            expect(deleted.deletedAt).toBeDefined();
            expect(deleted.deletedAt).toBeInstanceOf(Date);
        });

        it('should not return soft-deleted products in normal queries', async () => {
            const product = await productRepository.create({
                name: 'Will Be Deleted',
                category: 'test',
                basePrice: 100,
            });

            await productRepository.delete(product._id);

            // Normal getAll should not include deleted
            const result = await productRepository.getAll({});
            expect(result.docs).toHaveLength(0);
        });

        it('should return soft-deleted products with includeDeleted option', async () => {
            const product = await productRepository.create({
                name: 'Will Be Deleted',
                category: 'test',
                basePrice: 100,
            });

            await productRepository.delete(product._id);

            // getDeleted should return it
            const result = await productRepository.getDeleted({});
            expect(result.docs).toHaveLength(1);
            expect(result.docs[0].name).toBe('Will Be Deleted');
        });

        it('should restore soft-deleted product', async () => {
            const product = await productRepository.create({
                name: 'Will Be Restored',
                category: 'test',
                basePrice: 100,
            });

            await productRepository.delete(product._id);

            // Verify deleted
            let deleted = await Product.findById(product._id);
            expect(deleted.deletedAt).toBeDefined();

            // Restore
            await productRepository.restore(product._id);

            // Verify restored
            const restored = await Product.findById(product._id);
            expect(restored.deletedAt).toBeNull();
            expect(restored.isActive).toBe(true);
        });
    });
});
