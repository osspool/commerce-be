/**
 * Update Order Status Workflow
 * Updates order fulfillment status through the workflow
 *
 * Status flow: pending -> processing -> confirmed -> shipped -> delivered
 *
 * IMPORTANT: Uses orderRepository for proper event hooks
 */

import orderRepository from '../order.repository.js';
import { ORDER_STATUS, STATUS_TRANSITIONS } from '../order.enums.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import type { OrderDocument } from '../order.model.js';

interface UpdateStatusOptions {
  status: string;
  note?: string | null;
  request?: unknown;
}

interface StatusError extends Error {
  statusCode?: number;
}

interface UpdateStatusResult {
  order: OrderDocument;
  previousStatus?: string;
}

/**
 * Update Order Status Workflow
 */
export async function updateStatusWorkflow(orderId: string, options: UpdateStatusOptions): Promise<UpdateStatusResult> {
  const { status, note = null, request = null } = options;

  if (!status) {
    throw new Error('Status is required');
  }

  const validStatuses = Object.values(ORDER_STATUS) as string[];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
  }

  const order = (await orderRepository.getById(orderId, { lean: false })) as OrderDocument;
  if (!order) {
    const error = new Error('Order not found') as StatusError;
    error.statusCode = 404;
    throw error;
  }

  const allowedTransitions = STATUS_TRANSITIONS[order.status] || [];
  if (!allowedTransitions.includes(status) && order.status !== status) {
    throw new Error(
      `Cannot transition from ${order.status} to ${status}. Allowed: ${allowedTransitions.join(', ') || 'none'}`,
    );
  }

  if (order.status === status) {
    return { order };
  }

  const previousStatus = order.status;
  const previousPaymentStatus = order.currentPayment?.status;
  const now = new Date();

  order.status = status;

  if (status === ORDER_STATUS.SHIPPED && !(order as unknown as Record<string, unknown>).shippedAt) {
    (order as unknown as Record<string, unknown>).shippedAt = now;
  }
  if (status === ORDER_STATUS.DELIVERED && !(order as unknown as Record<string, unknown>).deliveredAt) {
    (order as unknown as Record<string, unknown>).deliveredAt = now;
  }

  if (order.addTimelineEvent) {
    order.addTimelineEvent(
      'order.status_changed',
      `Status: ${previousStatus} -> ${status}${note ? `: ${note}` : ''}`,
      request,
      { previousStatus, newStatus: status, note },
    );
  }

  await order.save();

  notifyEvent.orderStatusChanged({
    orderId: String(order._id),
    organizationId: String(order.branch),
    orderNumber: order.orderNumber || '',
    status,
    triggeredBy: (options?.request as Record<string, unknown>)?.user
      ? String(((options.request as Record<string, unknown>).user as Record<string, unknown>)?.id)
      : undefined,
  });

  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus },
    result: order,
  });

  return { order, previousStatus };
}

export default updateStatusWorkflow;
