import { Repository } from '@classytic/mongokit';
import Cart from './cart.model.js';
import Product from '#modules/commerce/product/product.model.js';

class CartRepository extends Repository {
  constructor() {
    super(Cart, [], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  async getOrCreateCart(userId) {
    let cart = await this.Model.findOne({ user: userId })
      .populate({
        path: 'items.product',
        select: 'name images basePrice currentPrice discount slug shipping productType variants variationAttributes',
      })
      .exec();

    if (!cart) {
      cart = await this.create({ user: userId, items: [] });
      cart = await this.Model.findById(cart._id)
        .populate({
          path: 'items.product',
          select: 'name images basePrice currentPrice discount slug shipping productType variants variationAttributes',
        })
        .exec();
    }

    return cart;
  }

  async addItem(userId, productId, variantSku = null, quantity) {
    const product = await Product.findById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    this.validateQuantity(product, variantSku, quantity);

    let cart = await this.Model.findOne({ user: userId });
    if (!cart) {
      cart = new this.Model({ user: userId, items: [] });
    }

    const existingItemIndex = cart.items.findIndex(
      (item) =>
        item.product.toString() === productId &&
        item.variantSku === variantSku
    );

    if (existingItemIndex > -1) {
      cart.items[existingItemIndex].quantity += quantity;
    } else {
      cart.items.push({ product: productId, variantSku, quantity });
    }

    await cart.save();
    return this.getOrCreateCart(userId);
  }

  async updateItem(userId, itemId, quantity) {
    const cart = await this.Model.findOne({ user: userId });
    if (!cart) {
      throw new Error('Cart not found');
    }

    const item = cart.items.id(itemId);
    if (!item) {
      throw new Error('Cart item not found');
    }

    const product = await Product.findById(item.product);
    this.validateQuantity(product, item.variantSku, quantity);

    item.quantity = quantity;
    await cart.save();
    return this.getOrCreateCart(userId);
  }

  async removeItem(userId, itemId) {
    const cart = await this.Model.findOne({ user: userId });
    if (!cart) {
      throw new Error('Cart not found');
    }

    const item = cart.items.id(itemId);
    if (!item) {
      throw new Error('Cart item not found');
    }

    item.deleteOne();
    await cart.save();
    return this.getOrCreateCart(userId);
  }

  async clearCart(userId) {
    const cart = await this.Model.findOne({ user: userId });
    if (!cart) {
      throw new Error('Cart not found');
    }

    cart.items = [];
    await cart.save();
    return this.getOrCreateCart(userId);
  }

  validateQuantity(product, variantSku, quantity) {
    if (quantity < 1) {
      throw new Error('Quantity must be at least 1');
    }

    // For simple products
    if (product.productType === 'simple') {
      if (variantSku) {
        throw new Error('Simple products cannot have variant SKU');
      }
      // Basic quantity check (detailed stock check happens at checkout)
      if (product.quantity < quantity) {
        throw new Error('Insufficient product quantity');
      }
      return;
    }

    // For variant products
    if (product.productType === 'variant') {
      if (!variantSku) {
        throw new Error('Variant products require variantSku');
      }

      const variant = product.variants?.find(v => v.sku === variantSku);
      if (!variant) {
        throw new Error(`Invalid variant SKU: ${variantSku}`);
      }

      if (!variant.isActive) {
        throw new Error(`Variant ${variantSku} is not available`);
      }

      // Stock validation happens at checkout via StockEntry
    }
  }
}

export default new CartRepository();
