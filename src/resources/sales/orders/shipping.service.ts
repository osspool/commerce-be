import orderRepository from './order.repository.js';
import type { OrderDocument, IShipping } from './order.model.js';
import {
  SHIPPING_STATUS,
  SHIPPING_STATUS_TRANSITIONS,
  SHIPPING_TO_ORDER_STATUS_MAP,
  ORDER_STATUS,
} from './order.enums.js';

interface ProviderData {
  provider: string;
  trackingNumber?: string;
  consignmentId?: string;
  trackingUrl?: string;
  labelUrl?: string;
  estimatedDelivery?: Date;
  metadata?: Record<string, unknown>;
}

interface StatusData {
  status: string;
  note?: string;
  metadata?: Record<string, unknown>;
}

interface ShippingContext {
  actorId?: string;
  request?: unknown;
  allowBootstrap?: boolean;
}

interface ShippingResult {
  order: OrderDocument;
  shipping: IShipping;
}

interface StatusError extends Error {
  statusCode?: number;
}

class ShippingService {
  async requestPickup(
    orderId: string,
    providerData: ProviderData,
    context: ShippingContext = {},
  ): Promise<ShippingResult> {
    const order = (await orderRepository.getById(orderId, { lean: false, throwOnNotFound: false })) as OrderDocument;

    if (!order) {
      throw this._error('Order not found', 404);
    }

    if (order.status === ORDER_STATUS.CANCELLED) {
      throw this._error('Cannot request shipping for cancelled order');
    }

    if (order.currentPayment?.status !== 'verified') {
      throw this._error('Payment must be verified before requesting shipping');
    }

    const { provider, trackingNumber, consignmentId, trackingUrl, labelUrl, estimatedDelivery, metadata } =
      providerData;

    order.shipping = {
      provider,
      status: SHIPPING_STATUS.REQUESTED,
      trackingNumber,
      consignmentId,
      trackingUrl,
      labelUrl,
      estimatedDelivery,
      requestedAt: new Date(),
      metadata,
      history: [
        {
          status: SHIPPING_STATUS.REQUESTED,
          note: `Pickup requested via ${provider}`,
          actor: context.actorId || 'system',
          timestamp: new Date(),
        },
      ],
    } as IShipping;

    if (order.addTimelineEvent) {
      order.addTimelineEvent('shipping.requested', `Shipping requested via ${provider}`, context.request, {
        provider,
        trackingNumber,
        consignmentId,
      });
    }

    await order.save();

    return { order, shipping: order.shipping as IShipping };
  }

  async updateStatus(orderId: string, statusData: StatusData, context: ShippingContext = {}): Promise<ShippingResult> {
    const order = (await orderRepository.getById(orderId, { lean: false, throwOnNotFound: false })) as OrderDocument;

    if (!order) {
      throw this._error('Order not found', 404);
    }

    const { status, note, metadata } = statusData;

    if (!order.shipping) {
      if (!context.allowBootstrap) {
        throw this._error('No shipping data found for this order');
      }

      const provider = ((metadata as Record<string, unknown>)?.provider as string) || 'other';
      const trackingNumber =
        ((metadata as Record<string, unknown>)?.trackingNumber as string) ||
        ((metadata as Record<string, unknown>)?.trackingId as string);
      order.shipping = {
        provider,
        status,
        trackingNumber,
        metadata,
        history: [],
      } as IShipping;
      this._updateTimestamps(order.shipping, status);
    }

    const currentStatus = order.shipping.status as string;

    if (!this._isValidTransition(currentStatus, status)) {
      if (!context.allowBootstrap) {
        throw this._error(`Invalid status transition: ${currentStatus} -> ${status}`);
      }
    }

    order.shipping.status = status;

    if (metadata) {
      order.shipping.metadata = { ...(order.shipping.metadata as Record<string, unknown>), ...metadata };
    }

    this._updateTimestamps(order.shipping, status);

    order.shipping.history = order.shipping.history || [];
    order.shipping.history.push({
      status,
      note: note || `Status updated to ${status}`,
      actor: context.actorId || 'system',
      timestamp: new Date(),
    });

    const newOrderStatus = SHIPPING_TO_ORDER_STATUS_MAP[status];
    if (newOrderStatus && this._shouldAdvanceOrderStatus(order.status, newOrderStatus)) {
      order.status = newOrderStatus;
    }

    if (order.addTimelineEvent) {
      order.addTimelineEvent(`shipping.${status}`, note || `Shipping status: ${status}`, context.request, {
        previousStatus: currentStatus,
        newStatus: status,
      });
    }

    await order.save();

    orderRepository.emit('shipping:statusChanged', {
      orderId: order._id,
      previousStatus: currentStatus,
      newStatus: status,
      order,
    });

    return { order, shipping: order.shipping as IShipping };
  }

  async getShippingInfo(orderId: string): Promise<IShipping | null> {
    const order = (await orderRepository.getById(orderId, { throwOnNotFound: false })) as OrderDocument;

    if (!order) {
      throw this._error('Order not found', 404);
    }

    return order.shipping || null;
  }

  _isValidTransition(from: string, to: string): boolean {
    const allowed = SHIPPING_STATUS_TRANSITIONS[from] || [];
    return allowed.includes(to);
  }

  _shouldAdvanceOrderStatus(currentOrderStatus: string, targetOrderStatus: string): boolean {
    const statusOrder = [
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PROCESSING,
      ORDER_STATUS.CONFIRMED,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.DELIVERED,
    ];

    const currentIndex = statusOrder.indexOf(currentOrderStatus as (typeof statusOrder)[number]);
    const targetIndex = statusOrder.indexOf(targetOrderStatus as (typeof statusOrder)[number]);

    return targetIndex > currentIndex;
  }

  _updateTimestamps(shipping: IShipping, status: string): void {
    const now = new Date();

    switch (status) {
      case SHIPPING_STATUS.PICKED_UP:
        shipping.pickedUpAt = now;
        break;
      case SHIPPING_STATUS.DELIVERED:
        shipping.deliveredAt = now;
        break;
    }
  }

  _error(message: string, statusCode: number = 400): StatusError {
    const error = new Error(message) as StatusError;
    error.statusCode = statusCode;
    return error;
  }
}

export default new ShippingService();
