/**
 * Order Status Handler
 * Handles order status updates (admin only)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { updateStatusWorkflow } from '../workflows/index.js';
import orderRepository from '../order.repository.js';

interface StatusError extends Error {
  statusCode?: number;
}

/**
 * Update Order Status Handler
 */
export async function updateStatusHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const { status, note } = request.body as { status: string; note?: string };

    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const result = await updateStatusWorkflow(orderId, { status, note, request });

    return reply.send({
      success: true,
      data: result.order,
      previousStatus: result.previousStatus,
      message: `Order status updated to ${status}`,
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to update order status',
    });
  }
}
