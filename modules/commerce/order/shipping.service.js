import orderRepository from './order.repository.js';
import { 
  SHIPPING_STATUS, 
  SHIPPING_STATUS_TRANSITIONS, 
  SHIPPING_TO_ORDER_STATUS_MAP,
  ORDER_STATUS 
} from './order.enums.js';

class ShippingService {
  async requestPickup(orderId, providerData, context = {}) {
    const order = await orderRepository.getById(orderId, { lean: false });
    
    if (!order) {
      throw this._error('Order not found', 404);
    }

    if (order.status === ORDER_STATUS.CANCELLED) {
      throw this._error('Cannot request shipping for cancelled order');
    }

    if (order.currentPayment?.status !== 'verified') {
      throw this._error('Payment must be verified before requesting shipping');
    }

    const { provider, trackingNumber, consignmentId, trackingUrl, labelUrl, estimatedDelivery, metadata } = providerData;

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
      history: [{
        status: SHIPPING_STATUS.REQUESTED,
        note: `Pickup requested via ${provider}`,
        actor: context.actorId || 'system',
        timestamp: new Date(),
      }],
    };

    if (order.addTimelineEvent) {
      order.addTimelineEvent('shipping.requested', `Shipping requested via ${provider}`, context.request, {
        provider,
        trackingNumber,
        consignmentId,
      });
    }

    await order.save();

    return { order, shipping: order.shipping };
  }

  async updateStatus(orderId, statusData, context = {}) {
    const order = await orderRepository.getById(orderId, { lean: false });
    
    if (!order) {
      throw this._error('Order not found', 404);
    }

    if (!order.shipping) {
      throw this._error('No shipping data found for this order');
    }

    const { status, note, metadata } = statusData;
    const currentStatus = order.shipping.status;

    if (!this._isValidTransition(currentStatus, status)) {
      throw this._error(`Invalid status transition: ${currentStatus} → ${status}`);
    }

    order.shipping.status = status;
    
    if (metadata) {
      order.shipping.metadata = { ...order.shipping.metadata, ...metadata };
    }

    this._updateTimestamps(order.shipping, status);

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

    return { order, shipping: order.shipping };
  }

  async getShippingInfo(orderId) {
    const order = await orderRepository.getById(orderId);
    
    if (!order) {
      throw this._error('Order not found', 404);
    }

    return order.shipping || null;
  }

  _isValidTransition(from, to) {
    const allowed = SHIPPING_STATUS_TRANSITIONS[from] || [];
    return allowed.includes(to);
  }

  _shouldAdvanceOrderStatus(currentOrderStatus, targetOrderStatus) {
    const statusOrder = [
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PROCESSING,
      ORDER_STATUS.CONFIRMED,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.DELIVERED,
    ];
    
    const currentIndex = statusOrder.indexOf(currentOrderStatus);
    const targetIndex = statusOrder.indexOf(targetOrderStatus);
    
    return targetIndex > currentIndex;
  }

  _updateTimestamps(shipping, status) {
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

  _error(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
}

export default new ShippingService();
