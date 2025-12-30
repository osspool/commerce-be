import { Repository } from '@classytic/mongokit';
import Cart from './cart.model.js';
import Product from '#modules/catalog/products/product.model.js';

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

  // Admin methods

  /**
   * Get all carts with pagination (admin only)
   */
  async getAllCarts(options = {}) {
    const { page = 1, limit = 20, sort = '-updatedAt', populate = true } = options;

    let query = this.Model.find()
      .skip((page - 1) * limit)
      .limit(limit)
      .sort(sort);

    if (populate) {
      query = query
        .populate({
          path: 'user',
          select: 'name email phone',
        })
        .populate({
          path: 'items.product',
          select: 'name images basePrice currentPrice discount slug',
        });
    }

    const carts = await query.exec();
    const total = await this.Model.countDocuments();

    return {
      data: carts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get abandoned carts (items in cart but no recent orders)
   * For marketing purposes
   */
  async getAbandonedCarts(daysOld = 7, options = {}) {
    const { page = 1, limit = 20 } = options;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    // Find carts with items that haven't been updated recently
    const carts = await this.Model.find({
      'items.0': { $exists: true }, // Has at least one item
      updatedAt: { $lt: cutoffDate },
    })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({
        path: 'user',
        select: 'name email phone',
      })
      .populate({
        path: 'items.product',
        select: 'name images basePrice currentPrice discount slug',
      })
      .sort('-updatedAt')
      .exec();

    const total = await this.Model.countDocuments({
      'items.0': { $exists: true },
      updatedAt: { $lt: cutoffDate },
    });

    return {
      data: carts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get cart by user ID (admin only)
   */
  async getCartByUserId(userId) {
    return await this.Model.findOne({ user: userId })
      .populate({
        path: 'user',
        select: 'name email phone',
      })
      .populate({
        path: 'items.product',
        select: 'name images basePrice currentPrice discount slug shipping productType variants variationAttributes',
      })
      .exec();
  }
}

export default new CartRepository();
