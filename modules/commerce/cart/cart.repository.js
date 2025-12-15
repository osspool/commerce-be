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
        select: 'name images variations discount basePrice slug shipping',
      })
      .exec();

    if (!cart) {
      cart = await this.create({ user: userId, items: [] });
      cart = await this.Model.findById(cart._id)
        .populate({
          path: 'items.product',
          select: 'name images variations discount basePrice slug shipping',
        })
        .exec();
    }

    return cart;
  }

  async addItem(userId, productId, variations, quantity) {
    const product = await Product.findById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    this.validateQuantity(product, variations, quantity);

    let cart = await this.Model.findOne({ user: userId });
    if (!cart) {
      cart = new this.Model({ user: userId, items: [] });
    }

    const existingItemIndex = cart.items.findIndex(
      (item) =>
        item.product.toString() === productId &&
        JSON.stringify(item.variations) === JSON.stringify(variations)
    );

    if (existingItemIndex > -1) {
      cart.items[existingItemIndex].quantity += quantity;
    } else {
      cart.items.push({ product: productId, variations, quantity });
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
    this.validateQuantity(product, item.variations, quantity);

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

  validateQuantity(product, variations, quantity) {
    if (product.quantity < quantity) {
      throw new Error('Insufficient product quantity');
    }

    if (variations && variations.length > 0) {
      for (const userVariation of variations) {
        const productVariation = product.variations.find(
          (v) => v.name === userVariation.name
        );

        if (!productVariation) {
          throw new Error(`Invalid variation: ${userVariation.name}`);
        }

        const selectedOption = productVariation.options.find(
          (opt) => opt.value === userVariation.option.value
        );

        if (!selectedOption) {
          throw new Error(
            `Invalid option for variation ${userVariation.name}: ${userVariation.option.value}`
          );
        }

        if (selectedOption.quantity < quantity) {
          throw new Error(
            `Insufficient quantity for variation ${userVariation.name} with option ${selectedOption.value}. Available: ${selectedOption.quantity}, Requested: ${quantity}`
          );
        }
      }
    }
  }
}

export default new CartRepository();
