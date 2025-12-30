import cartRepository from './cart.repository.js';

class CartController {
  constructor() {
    this.getCart = this.getCart.bind(this);
    this.addItem = this.addItem.bind(this);
    this.updateItem = this.updateItem.bind(this);
    this.removeItem = this.removeItem.bind(this);
    this.clearCart = this.clearCart.bind(this);
    // Admin methods
    this.listAllCarts = this.listAllCarts.bind(this);
    this.getAbandonedCarts = this.getAbandonedCarts.bind(this);
    this.getUserCart = this.getUserCart.bind(this);
  }

  async getCart(req, reply) {
    try {
      const cart = await cartRepository.getOrCreateCart(req.user._id);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  async addItem(req, reply) {
    const { productId, variantSku = null, quantity } = req.body;

    try {
      const cart = await cartRepository.addItem(
        req.user._id,
        productId,
        variantSku,
        quantity
      );
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: error.message });
    }
  }

  async updateItem(req, reply) {
    const { itemId } = req.params;
    const { quantity } = req.body;

    try {
      const cart = await cartRepository.updateItem(req.user._id, itemId, quantity);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: error.message });
    }
  }

  async removeItem(req, reply) {
    const { itemId } = req.params;

    try {
      const cart = await cartRepository.removeItem(req.user._id, itemId);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: error.message });
    }
  }

  async clearCart(req, reply) {
    try {
      const cart = await cartRepository.clearCart(req.user._id);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: error.message });
    }
  }

  // Admin methods

  /**
   * List all carts (admin only)
   */
  async listAllCarts(req, reply) {
    try {
      const { page, limit, sort } = req.query;
      const result = await cartRepository.getAllCarts({ page, limit, sort });
      return reply.code(200).send({ success: true, ...result });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  /**
   * Get abandoned carts (admin only)
   * For marketing purposes - users with items in cart but no recent orders
   */
  async getAbandonedCarts(req, reply) {
    try {
      const { daysOld = 7, page, limit } = req.query;
      const result = await cartRepository.getAbandonedCarts(daysOld, { page, limit });
      return reply.code(200).send({
        success: true,
        ...result,
        metadata: { daysOld }
      });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  /**
   * Get specific user's cart (admin only)
   */
  async getUserCart(req, reply) {
    try {
      const { userId } = req.params;
      const cart = await cartRepository.getCartByUserId(userId);

      if (!cart) {
        return reply.code(404).send({
          success: false,
          message: 'Cart not found for this user'
        });
      }

      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }
}

export default new CartController();
