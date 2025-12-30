import orderRepository from '../order.repository.js';

export async function requestCancelHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const { reason = null } = request.body || {};
    const userId = request.user?._id;

    const order = await orderRepository.getById(orderId, { lean: false });
    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    // Only owner or admin can request cancellation
    const roles = Array.isArray(request.user?.roles) ? request.user.roles : [];
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');
    const customerId = request.user?.customer || request.user?.customerId;
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
      reason,
      requestedAt: new Date(),
      requestedBy: userId,
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
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to request cancellation',
    });
  }
}
