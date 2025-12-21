import shippingService from '../shipping.service.js';
import orderRepository from '../order.repository.js';

/**
 * Request shipping pickup
 *
 * Two modes:
 * 1. Manual entry (default): Records provider/tracking in order.shipping
 * 2. API integration: If useProviderApi=true, creates shipment via logistics module
 *
 * For direct logistics API, use: POST /logistics/shipments { orderId }
 */
export async function requestShippingHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const providerData = request.body;
    const { useProviderApi = false } = providerData;

    request.log.info({ orderId, provider: providerData.provider, useProviderApi }, 'Shipping pickup requested');

    // API integration mode: Create shipment via logistics module
    if (useProviderApi) {
      try {
        const logisticsService = (await import('../../../logistics/services/logistics.service.js')).default;
        const order = await orderRepository.getById(orderId, { lean: false });

        if (!order) {
          return reply.code(404).send({ success: false, message: 'Order not found' });
        }

        if (order.currentPayment?.status !== 'verified') {
          return reply.code(400).send({ success: false, message: 'Payment must be verified before shipping' });
        }

        const shipment = await logisticsService.createShipment(order, {
          provider: providerData.provider,
          weight: providerData.weight,
          instructions: providerData.instructions,
          userId: request.user?._id,
        });

        // Update order with shipment info
        order.shipping = {
          provider: providerData.provider,
          status: 'requested',
          trackingNumber: shipment.trackingId,
          consignmentId: shipment._id?.toString(),
          requestedAt: new Date(),
          metadata: { shipmentId: shipment._id },
          history: [{
            status: 'requested',
            note: `Shipment created via ${providerData.provider} API`,
            actor: request.user?._id?.toString() || 'system',
            timestamp: new Date(),
          }],
        };

        if (order.addTimelineEvent) {
          order.addTimelineEvent('shipping.requested', `Shipment created via ${providerData.provider}`, request, {
            trackingId: shipment.trackingId,
            shipmentId: shipment._id,
          });
        }

        await order.save();

        return reply.send({
          success: true,
          data: { shipping: order.shipping, shipment },
          message: `Shipment created via ${providerData.provider} API`,
        });
      } catch (logisticsError) {
        request.log.error(logisticsError, 'Logistics API integration failed');
        return reply.code(400).send({
          success: false,
          message: logisticsError.message || 'Failed to create shipment via provider API',
        });
      }
    }

    // Default: Manual entry (no API call)
    const context = {
      actorId: request.user?._id?.toString(),
      request,
    };

    const result = await shippingService.requestPickup(orderId, providerData, context);

    return reply.send({
      success: true,
      data: result.shipping,
      message: `Shipping requested via ${providerData.provider}`,
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to request shipping',
    });
  }
}

export async function updateShippingStatusHandler(request, reply) {
  try {
    const orderId = request.params.id;
    const statusData = request.body;

    const context = {
      actorId: request.user?._id?.toString(),
      request,
    };

    const result = await shippingService.updateStatus(orderId, statusData, context);

    return reply.send({
      success: true,
      data: result.shipping,
      orderStatus: result.order.status,
      message: `Shipping status updated to ${statusData.status}`,
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to update shipping status',
    });
  }
}

export async function getShippingInfoHandler(request, reply) {
  try {
    const orderId = request.params.id;
    // Security: users should only see shipping for their own orders.
    // Admins can view any order shipping.
    const order = await orderRepository.getById(orderId);

    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    const roles = Array.isArray(request.user?.roles) ? request.user.roles : [];
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');

    if (!isAdmin) {
      const userId = request.user?._id;
      const customerId = request.user?.customer || request.user?.customerId;
      const isOwner =
        (order.userId && userId && order.userId.toString() === userId.toString()) ||
        (customerId && order.customer?.toString() === customerId.toString());

      if (!isOwner) {
        return reply.code(403).send({
          success: false,
          message: 'Access denied',
        });
      }
    }

    const shipping = order.shipping || null;

    return reply.send({
      success: true,
      data: shipping,
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(error.statusCode || 400).send({
      success: false,
      message: error.message || 'Failed to get shipping info',
    });
  }
}
