/**
 * Purchase Order Handlers
 * Handles purchase-type order operations (refund, fulfill, cancel)
 * 
 * Single-tenant version - simplified without organization scoping
 * Uses repository for data access
 */

import {
  refundOrderWorkflow,
  fulfillOrderWorkflow,
  cancelOrderWorkflow,
} from '../workflows/index.js';
import orderRepository from '../order.repository.js';

/**
 * Refund Order Handler
 * Admin endpoint to refund order payment
 */
export async function refundOrderHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const { amount = null, reason } = request.body;

    // Validate order exists using repository
    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    const result = await refundOrderWorkflow(orderId, {
      amount,
      reason,
      request,
    });

    return reply.send({
      success: true,
      data: result.order,
      refundTransaction: result.refundTransaction?._id,
      isPartialRefund: result.isPartialRefund,
      message: result.isPartialRefund ? 'Partial refund processed' : 'Full refund processed',
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to refund order',
    });
  }
}

/**
 * Fulfill Order Handler
 * Admin endpoint to mark order as shipped
 */
export async function fulfillOrderHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const {
      trackingNumber = null,
      carrier = null,
      notes = null,
      shippedAt = null,
      estimatedDelivery = null,
    } = request.body;

    // Validate order exists using repository
    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    const result = await fulfillOrderWorkflow(orderId, {
      trackingNumber,
      carrier,
      notes,
      shippedAt,
      estimatedDelivery,
      request,
    });

    return reply.send({
      success: true,
      data: result.order,
      message: 'Order fulfilled successfully',
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to fulfill order',
    });
  }
}

/**
 * Cancel Order Handler
 * Admin/User endpoint to cancel order with optional refund
 */
export async function cancelOrderHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const { reason = null, refund = false } = request.body;

    // Validate order exists using repository
    const order = await orderRepository.getById(orderId);
    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    // Check permission: owner or admin
    const userId = request.user._id;
    const isAdmin = request.user.role === 'admin';
    
    if (!isAdmin && order.customer.toString() !== userId.toString()) {
      return reply.code(403).send({
        success: false,
        message: 'Access denied',
      });
    }

    const result = await cancelOrderWorkflow(orderId, {
      reason,
      refundOptions: refund ? { enabled: true } : null,
      request,
    });

    return reply.send({
      success: true,
      data: result.order,
      refund: result.refund ? {
        transactionId: result.refund.transaction?._id,
        amount: result.refund.amount,
      } : null,
      message: result.refund ? 'Order cancelled and refunded' : 'Order cancelled',
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to cancel order',
    });
  }
}
