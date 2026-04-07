import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';

/**
 * Cart Operations Tests
 *
 * Integration tests for CartRepository using mongodb-memory-server.
 * Tests cart CRUD, duplicate item handling, validation, and population.
 */

// Ensure mongoose is connected (global-setup.js provides MONGO_URI)
let shouldDisconnect = false;

// Models & repository loaded after connection
let Cart: typeof import('#resources/sales/cart/cart.model.js').default;
let Product: typeof import('#resources/catalog/products/product.model.js').default;
let cartRepository: typeof import('#resources/sales/cart/cart.repository.js').default;

const userId = new Types.ObjectId().toString();

// Helper: create a simple product in DB
async function createSimpleProduct(overrides: Record<string, unknown> = {}) {
  const uniqueSku = `CART-TEST-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return Product.create({
    name: 'Cart Test Product',
    basePrice: 1000,
    quantity: 100,
    sku: uniqueSku,
    barcode: `BAR-${uniqueSku}`,
    category: 'test-category',
    isActive: true,
    productType: 'simple',
    ...overrides,
  });
}

// Helper: create a variant product in DB
async function createVariantProduct() {
  const uniqueSku = `CART-VAR-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return Product.create({
    name: 'Cart Variant Product',
    basePrice: 500,
    quantity: 0,
    sku: uniqueSku,
    barcode: `BAR-${uniqueSku}`,
    category: 'test-category',
    isActive: true,
    productType: 'variant',
    variationAttributes: [
      { name: 'Size', values: ['S', 'M', 'L'] },
    ],
    variants: [
      { sku: `${uniqueSku}-S`, attributes: { size: 's' }, priceModifier: 0, isActive: true },
      { sku: `${uniqueSku}-M`, attributes: { size: 'm' }, priceModifier: 50, isActive: true },
      { sku: `${uniqueSku}-L`, attributes: { size: 'l' }, priceModifier: 100, isActive: false },
    ],
  });
}

describe('Cart Operations (CartRepository)', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI!);
      shouldDisconnect = true;
    }

    // Dynamic imports after connection is established
    Cart = (await import('#resources/sales/cart/cart.model.js')).default;
    Product = (await import('#resources/catalog/products/product.model.js')).default;
    cartRepository = (await import('#resources/sales/cart/cart.repository.js')).default;
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    // Clean cart and product collections between tests
    await Cart.deleteMany({});
    await Product.deleteMany({});
  });

  // ─── getOrCreateCart ───────────────────────────────────

  describe('getOrCreateCart', () => {
    it('creates a new empty cart when none exists for user', async () => {
      const cart = await cartRepository.getOrCreateCart(userId);

      expect(cart).toBeDefined();
      expect(cart!.user.toString()).toBe(userId);
      expect(cart!.items).toHaveLength(0);
    });

    it('returns existing cart if one already exists', async () => {
      const first = await cartRepository.getOrCreateCart(userId);
      const second = await cartRepository.getOrCreateCart(userId);

      expect(first!._id.toString()).toBe(second!._id.toString());
    });
  });

  // ─── addItem ───────────────────────────────────────────

  describe('addItem', () => {
    it('adds a simple product item to cart (creates cart if not exists)', async () => {
      const product = await createSimpleProduct();
      const productId = product._id.toString();

      const cart = await cartRepository.addItem(userId, productId, null, 2);

      expect(cart).toBeDefined();
      expect(cart!.items).toHaveLength(1);
      expect(cart!.items[0].quantity).toBe(2);
      expect(String(cart!.items[0].product._id ?? cart!.items[0].product)).toBe(productId);
    });

    it('increases quantity when adding duplicate item (same product + variantSku)', async () => {
      const product = await createSimpleProduct();
      const productId = product._id.toString();

      await cartRepository.addItem(userId, productId, null, 1);
      const cart = await cartRepository.addItem(userId, productId, null, 3);

      expect(cart!.items).toHaveLength(1);
      expect(cart!.items[0].quantity).toBe(4);
    });

    it('adds variant product with variantSku', async () => {
      const product = await createVariantProduct();
      const productId = product._id.toString();
      const variantSku = (product as any).variants[0].sku;

      const cart = await cartRepository.addItem(userId, productId, variantSku, 1);

      expect(cart!.items).toHaveLength(1);
      expect(cart!.items[0].variantSku).toBe(variantSku);
    });

    it('treats different variantSkus as separate items', async () => {
      const product = await createVariantProduct();
      const productId = product._id.toString();
      const skuS = (product as any).variants[0].sku;
      const skuM = (product as any).variants[1].sku;

      await cartRepository.addItem(userId, productId, skuS, 1);
      const cart = await cartRepository.addItem(userId, productId, skuM, 2);

      expect(cart!.items).toHaveLength(2);
    });

    it('throws when product does not exist', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        cartRepository.addItem(userId, fakeId, null, 1),
      ).rejects.toThrow('Product not found');
    });

    it('throws when simple product is given a variantSku', async () => {
      const product = await createSimpleProduct();

      await expect(
        cartRepository.addItem(userId, product._id.toString(), 'FAKE-SKU', 1),
      ).rejects.toThrow('Simple products cannot have variant SKU');
    });

    it('throws when variant product is missing variantSku', async () => {
      const product = await createVariantProduct();

      await expect(
        cartRepository.addItem(userId, product._id.toString(), null, 1),
      ).rejects.toThrow('Variant products require variantSku');
    });

    it('throws for invalid variant SKU', async () => {
      const product = await createVariantProduct();

      await expect(
        cartRepository.addItem(userId, product._id.toString(), 'NONEXISTENT-SKU', 1),
      ).rejects.toThrow('Invalid variant SKU');
    });

    it('throws for inactive variant', async () => {
      const product = await createVariantProduct();
      const inactiveSku = (product as any).variants[2].sku; // L variant, isActive: false

      await expect(
        cartRepository.addItem(userId, product._id.toString(), inactiveSku, 1),
      ).rejects.toThrow('is not available');
    });

    it('throws when quantity exceeds available stock for simple product', async () => {
      const product = await createSimpleProduct({ quantity: 5 });

      await expect(
        cartRepository.addItem(userId, product._id.toString(), null, 10),
      ).rejects.toThrow('Insufficient product quantity');
    });

    it('throws when quantity is less than 1', async () => {
      const product = await createSimpleProduct();

      await expect(
        cartRepository.addItem(userId, product._id.toString(), null, 0),
      ).rejects.toThrow('Quantity must be at least 1');
    });
  });

  // ─── updateItem ────────────────────────────────────────

  describe('updateItem', () => {
    it('updates quantity of an existing cart item', async () => {
      const product = await createSimpleProduct();
      const cart = await cartRepository.addItem(userId, product._id.toString(), null, 1);
      const itemId = cart!.items[0]._id!.toString();

      const updated = await cartRepository.updateItem(userId, itemId, 5);

      expect(updated!.items[0].quantity).toBe(5);
    });

    it('throws when cart does not exist', async () => {
      const fakeUserId = new Types.ObjectId().toString();
      const fakeItemId = new Types.ObjectId().toString();

      await expect(
        cartRepository.updateItem(fakeUserId, fakeItemId, 1),
      ).rejects.toThrow('Cart not found');
    });

    it('throws when item is not in cart', async () => {
      // Create cart by adding an item first
      const product = await createSimpleProduct();
      await cartRepository.addItem(userId, product._id.toString(), null, 1);
      const fakeItemId = new Types.ObjectId().toString();

      await expect(
        cartRepository.updateItem(userId, fakeItemId, 1),
      ).rejects.toThrow('Cart item not found');
    });
  });

  // ─── removeItem ────────────────────────────────────────

  describe('removeItem', () => {
    it('removes a specific item from cart', async () => {
      const product1 = await createSimpleProduct({ quantity: 50 });
      const product2 = await createSimpleProduct({ quantity: 50 });

      await cartRepository.addItem(userId, product1._id.toString(), null, 1);
      const cart = await cartRepository.addItem(userId, product2._id.toString(), null, 1);

      expect(cart!.items).toHaveLength(2);

      const itemToRemove = cart!.items[0]._id!.toString();
      const updated = await cartRepository.removeItem(userId, itemToRemove);

      expect(updated!.items).toHaveLength(1);
    });

    it('throws when cart does not exist', async () => {
      const fakeUserId = new Types.ObjectId().toString();

      await expect(
        cartRepository.removeItem(fakeUserId, new Types.ObjectId().toString()),
      ).rejects.toThrow('Cart not found');
    });

    it('throws when item is not in cart', async () => {
      const product = await createSimpleProduct();
      await cartRepository.addItem(userId, product._id.toString(), null, 1);

      await expect(
        cartRepository.removeItem(userId, new Types.ObjectId().toString()),
      ).rejects.toThrow('Cart item not found');
    });
  });

  // ─── clearCart ─────────────────────────────────────────

  describe('clearCart', () => {
    it('removes all items from cart', async () => {
      const product1 = await createSimpleProduct({ quantity: 50 });
      const product2 = await createSimpleProduct({ quantity: 50 });

      await cartRepository.addItem(userId, product1._id.toString(), null, 1);
      await cartRepository.addItem(userId, product2._id.toString(), null, 2);

      const cleared = await cartRepository.clearCart(userId);

      expect(cleared!.items).toHaveLength(0);
    });

    it('throws when cart does not exist', async () => {
      const fakeUserId = new Types.ObjectId().toString();

      await expect(
        cartRepository.clearCart(fakeUserId),
      ).rejects.toThrow('Cart not found');
    });
  });

  // ─── getOrCreateCart with population ───────────────────

  describe('cart with product population', () => {
    it('populates product data in cart items', async () => {
      const product = await createSimpleProduct({ name: 'Populated Product' });
      const cart = await cartRepository.addItem(userId, product._id.toString(), null, 1);

      // addItem returns populated cart via getOrCreateCart
      const item = cart!.items[0];
      const populatedProduct = item.product as any;

      expect(populatedProduct).toBeDefined();
      expect(populatedProduct.name).toBe('Populated Product');
      expect(populatedProduct.basePrice).toBe(1000);
    });
  });
});
