import { BaseController } from '@classytic/arc';
import type { FastifyRequest, FastifyReply } from 'fastify';
import cartRepository from './cart.repository.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
}

class CartController extends BaseController {
  constructor() {
    super(cartRepository);
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

  /**
   * Get user ID from request - handles both JWT 'id' and '_id' formats
   */
  getUserId(req: FastifyRequest): string {
    const user = (req as unknown as { user: AuthenticatedUser }).user;
    return (user._id || user.id) as string;
  }

  async getCart(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const cart = await cartRepository.getOrCreateCart(this.getUserId(req));
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(500).send({ success: false, message: (error as Error).message });
    }
  }

  async addItem(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const {
      productId,
      variantSku = null,
      quantity,
    } = req.body as { productId: string; variantSku?: string | null; quantity: number };

    try {
      const cart = await cartRepository.addItem(this.getUserId(req), productId, variantSku, quantity);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message });
    }
  }

  async updateItem(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { itemId } = req.params as { itemId: string };
    const { quantity } = req.body as { quantity: number };

    try {
      const cart = await cartRepository.updateItem(this.getUserId(req), itemId, quantity);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message });
    }
  }

  async removeItem(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { itemId } = req.params as { itemId: string };

    try {
      const cart = await cartRepository.removeItem(this.getUserId(req), itemId);
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message });
    }
  }

  async clearCart(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const cart = await cartRepository.clearCart(this.getUserId(req));
      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(500).send({ success: false, message: (error as Error).message });
    }
  }

  // Admin methods

  /**
   * List all carts (admin only)
   */
  async listAllCarts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { page, limit, sort } = req.query as { page?: number; limit?: number; sort?: string };
      const result = await cartRepository.getAllCarts({ page, limit, sort });
      return reply.code(200).send({ success: true, ...result });
    } catch (error) {
      return reply.code(500).send({ success: false, message: (error as Error).message });
    }
  }

  /**
   * Get abandoned carts (admin only)
   * For marketing purposes - users with items in cart but no recent orders
   */
  async getAbandonedCarts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { daysOld = 7, page, limit } = req.query as { daysOld?: number; page?: number; limit?: number };
      const result = await cartRepository.getAbandonedCarts(daysOld, { page, limit });
      return reply.code(200).send({
        success: true,
        ...result,
        metadata: { daysOld },
      });
    } catch (error) {
      return reply.code(500).send({ success: false, message: (error as Error).message });
    }
  }

  /**
   * Get specific user's cart (admin only)
   */
  async getUserCart(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { userId } = req.params as { userId: string };
      const cart = await cartRepository.getCartByUserId(userId);

      if (!cart) {
        return reply.code(404).send({
          success: false,
          message: 'Cart not found for this user',
        });
      }

      return reply.code(200).send({ success: true, data: cart });
    } catch (error) {
      return reply.code(500).send({ success: false, message: (error as Error).message });
    }
  }
}

export default new CartController();
