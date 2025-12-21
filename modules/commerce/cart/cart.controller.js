import cartRepository from './cart.repository.js';

class CartController {
  constructor() {
    this.getCart = this.getCart.bind(this);
    this.addItem = this.addItem.bind(this);
    this.updateItem = this.updateItem.bind(this);
    this.removeItem = this.removeItem.bind(this);
    this.clearCart = this.clearCart.bind(this);
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
}

export default new CartController();
