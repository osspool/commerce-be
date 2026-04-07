/**
 * Purchase Order Handlers
 * Handles purchase-type order operations (refund, fulfill, cancel)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { refundOrderWorkflow, fulfillOrderWorkflow, cancelOrderWorkflow } from '../workflows/index.js';
import orderRepository from '../order.repository.js';
import { filterOrderCostPriceByUser } from '../order.costPrice.utils.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  role?: string | string[];
  [key: string]: unknown;
}

interface StatusError extends Error {
  statusCode?: number;
}

/**
 * Refund Order Handler
 */
export async function refundOrderHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const { amount = null, reason } = request.body as { amount?: number | null; reason?: string };
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const result = await refundOrderWorkflow(orderId, { amount, reason, request });

    return reply.send({
      success: true,
      data: filterOrderCostPriceByUser(result.order, user),
      refundTransaction: result.refundTransaction?._id,
      isPartialRefund: result.isPartialRefund,
      message: result.isPartialRefund ? 'Partial refund processed' : 'Full refund processed',
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to refund order',
    });
  }
}

/**
 * Fulfill Order Handler
 */
export async function fulfillOrderHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const body = request.body as Record<string, unknown>;
    const trackingNumber = (body.trackingNumber as string | null) ?? null;
    const carrier = (body.carrier as string | null) ?? null;
    const notes = (body.notes as string | null) ?? null;
    const shippedAt = (body.shippedAt as string | Date | null) ?? null;
    const estimatedDelivery = (body.estimatedDelivery as string | Date | null) ?? null;
    const branchId = (body.branchId as string | null) ?? null;
    const branchSlug = (body.branchSlug as string | null) ?? null;
    const recordCogs = (body.recordCogs as boolean) ?? false;
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const result = await fulfillOrderWorkflow(orderId, {
      trackingNumber,
      carrier,
      notes,
      shippedAt,
      estimatedDelivery,
      branchId,
      branchSlug,
      recordCogs,
      request: request as unknown as Record<string, unknown>,
    });

    return reply.send({
      success: true,
      data: filterOrderCostPriceByUser(result.order, user),
      cogsTransaction: result.cogsTransaction
        ? {
            _id: result.cogsTransaction._id,
            amount: result.cogsTransaction.amount,
            category: result.cogsTransaction.category,
          }
        : null,
      message: 'Order fulfilled successfully',
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to fulfill order',
    });
  }
}

/**
 * Cancel Order Handler
 */
export async function cancelOrderHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const { reason = null, refund = false } = request.body as { reason?: string | null; refund?: boolean };
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const userId = user._id || user.id;
    const roles = Array.isArray(user.role) ? user.role : [];
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');

    if (!order.customer) {
      if (!isAdmin) {
        return reply.code(403).send({ success: false, message: 'Access denied' });
      }
    } else {
      const isOwner = order.userId && order.userId.toString() === userId?.toString();
      if (!isAdmin && !isOwner) {
        return reply.code(403).send({ success: false, message: 'Access denied' });
      }
    }

    const result = await cancelOrderWorkflow(orderId, {
      reason,
      refundOptions: refund ? { enabled: true } : null,
      request,
    });

    return reply.send({
      success: true,
      data: filterOrderCostPriceByUser(result.order, user),
      refund: result.refund
        ? {
            transactionId: result.refund.transaction?._id,
            amount: result.refund.amount,
          }
        : null,
      message: result.refund ? 'Order cancelled and refunded' : 'Order cancelled',
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to cancel order',
    });
  }
}
