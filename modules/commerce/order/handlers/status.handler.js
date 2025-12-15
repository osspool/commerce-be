/**
 * Order Status Handler
 * Handles order status updates (admin only)
 * Uses repository for data access
 */

import { updateStatusWorkflow } from '../workflows/index.js';
import orderRepository from '../order.repository.js';

/**
 * Update Order Status Handler
 * Admin endpoint to update order fulfillment status
 */
export async function updateStatusHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const { status, note } = request.body;

    // Validate order exists using repository
    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    const result = await updateStatusWorkflow(orderId, {
      status,
      note,
      request,
    });

    return reply.send({
      success: true,
      data: result.order,
      previousStatus: result.previousStatus,
      message: `Order status updated to ${status}`,
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to update order status',
    });
  }
}
