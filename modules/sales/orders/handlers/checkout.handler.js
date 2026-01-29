/**
 * Checkout Handler
 * Handles order queries for authenticated users using repository
 * 
 * Note: Order creation is handled by controller.create (overridden method)
 */

import orderRepository from '../order.repository.js';
import { filterOrderCostPriceByUser } from '../order.costPrice.utils.js';

/**
 * Get My Orders Handler
 * Returns orders for authenticated user using repository getAll with filters
 */
export async function getMyOrdersHandler(request, reply) {
  try {
    const userId = request.user._id || request.user.id;
    const { limit, page, status, sort } = request.query;

    // Use repository getAll with customer filter
    // Orders store both customer and userId; for "my" routes we must
    // filter by the authenticated user's _id (userId field), not the
    // customer ObjectId.
    const result = await orderRepository.getAll({
      filters: {
        userId,
        ...(status && { status }),
      },
      page: page || 1,
      limit: limit || 20,
      sort: sort || '-createdAt',
    });

    // Return paginated docs in top-level for list endpoint
    return reply.send({
      success: true,
      ...filterOrderCostPriceByUser(result, request.user), // docs, total, page, pages, hasNext, hasPrev, limit
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
export async function getMyOrderHandler(request, reply) {
  try {
    const userId = request.user._id || request.user.id;
    const { id } = request.params;

    // Use repository getById then verify ownership
    const order = await orderRepository.getById(id);

    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    // Verify the authenticated user owns this order.
    // Primary link is userId; fall back to customerId if present on the user object.
    const customerId = request.user.customer || request.user.customerId;
    const isOwner =
      (order.userId && order.userId.toString() === userId.toString()) ||
      (customerId && order.customer?.toString() === customerId.toString());

    if (!isOwner) {
      return reply.code(403).send({
        success: false,
        message: 'Access denied',
      });
    }

    return reply.send({
      success: true,
      data: filterOrderCostPriceByUser(order, request.user),
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({
      success: false,
      message: 'Failed to fetch order',
    });
  }
}
