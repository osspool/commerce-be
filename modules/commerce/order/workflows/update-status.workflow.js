/**
 * Update Order Status Workflow
 * Updates order fulfillment status through the workflow
 * 
 * Status flow: pending → processing → confirmed → shipped → delivered
 * 
 * IMPORTANT: Uses orderRepository for proper event hooks
 */

import orderRepository from '../order.repository.js';
import { ORDER_STATUS, STATUS_TRANSITIONS } from '../order.enums.js';

/**
 * Update Order Status Workflow
 * 
 * @param {string} orderId - Order ID
 * @param {Object} options - Workflow options
 * @param {string} options.status - New status
 * @param {string|null} options.note - Status change note
 * @param {Object|null} options.request - Fastify request for timeline tracking
 * @returns {Promise<{order: Object}>}
 */
export async function updateStatusWorkflow(orderId, options = {}) {
  const { status, note = null, request = null } = options;

  if (!status) {
    throw new Error('Status is required');
  }

  // Validate status value
  const validStatuses = Object.values(ORDER_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
  }

  // Get order via repository
  const order = await orderRepository.getById(orderId, { lean: false });
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  // Validate status transition
  const allowedTransitions = STATUS_TRANSITIONS[order.status] || [];
  if (!allowedTransitions.includes(status) && order.status !== status) {
    throw new Error(`Cannot transition from ${order.status} to ${status}. Allowed: ${allowedTransitions.join(', ') || 'none'}`);
  }

  // Skip if same status
  if (order.status === status) {
    return { order };
  }

  const previousStatus = order.status;
  const previousPaymentStatus = order.currentPayment?.status;
  const now = new Date();

  // Update status
  order.status = status;

  // Update timestamps based on status
  if (status === ORDER_STATUS.SHIPPED && !order.shippedAt) {
    order.shippedAt = now;
  }
  if (status === ORDER_STATUS.DELIVERED && !order.deliveredAt) {
    order.deliveredAt = now;
  }

  // Add timeline event
  if (order.addTimelineEvent) {
    order.addTimelineEvent(
      'order.status_changed',
      `Status: ${previousStatus} → ${status}${note ? `: ${note}` : ''}`,
      request,
      { previousStatus, newStatus: status, note }
    );
  }

  await order.save();

  // Emit repository event for stats update
  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus },
    result: order,
  });

  return { order, previousStatus };
}

export default updateStatusWorkflow;
