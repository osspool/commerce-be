import type { FastifyRequest, FastifyReply } from 'fastify';
import shippingService from '../shipping.service.js';
import orderRepository from '../order.repository.js';
import type { OrderDocument } from '../order.model.js';
import { createDefaultLoader } from '#lib/utils/lazy-import.js';

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

const loadLogisticsService = createDefaultLoader('#resources/logistics/services/logistics.service.js');

/**
 * Request shipping pickup
 */
export async function requestShippingHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const providerData = request.body as Record<string, unknown>;
    const { useProviderApi = false } = providerData;
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    request.log.info({ orderId, provider: providerData.provider, useProviderApi }, 'Shipping pickup requested');

    if (useProviderApi) {
      try {
        const logisticsService = (await loadLogisticsService()) as Record<
          string,
          (...args: unknown[]) => Promise<Record<string, unknown>>
        >;
        const order = (await orderRepository.getById(orderId, { lean: false })) as unknown as OrderDocument | null;

        if (!order) {
          return reply.code(404).send({ success: false, message: 'Order not found' });
        }

        if (order.currentPayment?.status !== 'verified') {
          return reply.code(400).send({ success: false, message: 'Payment must be verified before shipping' });
        }

        const shipment = await logisticsService.createShipment(order, {
          provider: providerData.provider,
          pickupStoreId: providerData.pickupStoreId,
          weight: providerData.weight,
          instructions: providerData.instructions,
          userId: user?._id,
        });

        order.shipping = {
          provider: providerData.provider as string,
          status: 'requested',
          trackingNumber: shipment.trackingId as string,
          consignmentId: shipment._id?.toString(),
          requestedAt: new Date(),
          metadata: { shipmentId: shipment._id },
          history: [
            {
              status: 'requested',
              note: `Shipment created via ${providerData.provider} API`,
              actor: user?._id?.toString() || 'system',
              timestamp: new Date(),
            },
          ],
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
          message: (logisticsError as Error).message || 'Failed to create shipment via provider API',
        });
      }
    }

    // Default: Manual entry (no API call)
    const context = {
      actorId: user?._id?.toString(),
      request,
    };

    const result = await shippingService.requestPickup(
      orderId,
      providerData as Record<string, unknown> & { provider: string },
      context,
    );

    return reply.send({
      success: true,
      data: result.shipping,
      message: `Shipping requested via ${providerData.provider}`,
    });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to request shipping',
    });
  }
}

export async function updateShippingStatusHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const statusData = request.body as { status: string; note?: string; metadata?: Record<string, unknown> };
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    const context = {
      actorId: user?._id?.toString(),
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
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to update shipping status',
    });
  }
}

export async function getShippingInfoHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const orderId = (request.params as { id: string }).id;
    const user = (request as unknown as { user: AuthenticatedUser }).user;

    const order = await orderRepository.getById(orderId);

    if (!order) {
      return reply.code(404).send({ success: false, message: 'Order not found' });
    }

    const roles = Array.isArray(user?.role) ? user.role : [];
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');

    if (!isAdmin) {
      const userId = user?._id;
      const customerId = user?.customer || user?.customerId;
      const isOwner =
        (order.userId && userId && order.userId.toString() === userId.toString()) ||
        (customerId && order.customer?.toString() === customerId.toString());

      if (!isOwner) {
        return reply.code(403).send({ success: false, message: 'Access denied' });
      }
    }

    const shipping = order.shipping || null;

    return reply.send({ success: true, data: shipping });
  } catch (error) {
    request.log.error(error);
    const err = error as StatusError;
    return reply.code(err.statusCode || 400).send({
      success: false,
      message: err.message || 'Failed to get shipping info',
    });
  }
}
