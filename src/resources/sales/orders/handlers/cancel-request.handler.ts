import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Types } from 'mongoose';
import orderRepository from '../order.repository.js';
import type { OrderDocument } from '../order.model.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  role?: string | string[];
  customer?: string;
  customerId?: string;
}

interface StatusError extends Error {
  statusCode?: number;
}

export async function requestCancelHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const { reason = null } = (request.body as { reason?: string }) || {};
    const user = (request as unknown as { user: AuthenticatedUser }).user;
    const userId = user?._id;

    const order = (await orderRepository.getById(orderId, { lean: false })) as unknown as OrderDocument | null;
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    // Only owner or admin can request cancellation
    const roles = Array.isArray(user?.role) ? user.role : [];
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');
    const customerId = user?.customer || user?.customerId;
    const isOwner =
      (order.userId && userId && order.userId.toString() === userId.toString()) ||
      (customerId && order.customer?.toString() === customerId.toString());

    if (!isAdmin && !isOwner) {
      return reply.code(403).send({ success: false, message: 'Access denied' });
    }

    // If already cancelled or delivered, reject
    if (['cancelled', 'delivered'].includes(order.status)) {
      return reply.code(400).send({ success: false, message: 'Order cannot be cancelled' });
    }

    order.cancellationRequest = {
      requested: true,
      reason: reason ?? undefined,
      requestedAt: new Date(),
      requestedBy: userId as unknown as Types.ObjectId | undefined,
    };

    if (order.addTimelineEvent) {
      order.addTimelineEvent('order.cancel.requested', 'Cancellation requested', request, {
        reason,
        requestedBy: userId?.toString(),
      });
    }

    await order.save();

    return reply.send({
      success: true,
      data: { cancellationRequest: order.cancellationRequest },
      message: 'Cancellation requested. Awaiting admin review.',
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to request cancellation',
    });
  }
}
