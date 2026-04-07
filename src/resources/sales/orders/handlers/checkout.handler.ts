/**
 * Checkout Handler
 * Handles order queries for authenticated users using repository
 *
 * Note: Order creation is handled by controller.create (overridden method)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import orderRepository from '../order.repository.js';
import { filterOrderCostPriceByUser } from '../order.costPrice.utils.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  customer?: string;
  customerId?: string;
  [key: string]: unknown;
}

/**
 * Get My Orders Handler
 * Returns orders for authenticated user using repository getAll with filters
 */
export async function getMyOrdersHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const user = (request as unknown as { user: AuthenticatedUser }).user;
    const userId = user._id || user.id;
    const { limit, page, status, sort } = request.query as {
      limit?: number;
      page?: number;
      status?: string;
      sort?: string;
    };

    const result = await orderRepository.getAll({
      filters: {
        userId,
        ...(status && { status }),
      },
      page: page || 1,
      limit: limit || 20,
      sort: sort || '-createdAt',
    });

    return reply.send({
      success: true,
      ...filterOrderCostPriceByUser(result, user),
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({
      success: false,
      message: 'Failed to fetch orders',
    });
  }
}

/**
 * Get My Order Handler
 * Returns single order for authenticated user
 */
export async function getMyOrderHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const user = (request as unknown as { user: AuthenticatedUser }).user;
    const userId = user._id || user.id;
    const { id } = request.params as { id: string };

    const order = await orderRepository.getById(id);

    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    const customerId = user.customer || user.customerId;
    const isOwner =
      (order.userId && order.userId.toString() === userId?.toString()) ||
      (customerId && order.customer?.toString() === customerId.toString());

    if (!isOwner) {
      return reply.code(403).send({
        success: false,
        message: 'Access denied',
      });
    }

    return reply.send({
      success: true,
      data: filterOrderCostPriceByUser(order, user),
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({
      success: false,
      message: 'Failed to fetch order',
    });
  }
}
