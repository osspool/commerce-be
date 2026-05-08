/**
 * Notification Event Publisher
 *
 * Typed, fire-and-forget event publisher for notification-worthy actions.
 * Centralizes all `arcEvents.publish()` calls so workflows stay clean.
 *
 * Usage:
 *   import { notifyEvent } from '#resources/notifications/notification.publish.js';
 *   notifyEvent.orderCreated({ orderId, organizationId, orderNumber, customerName, amount, triggeredBy });
 */

import { publish } from '#lib/events/arcEvents.js';

// ── Helpers ──

function fire(event: string, payload: Record<string, unknown>): void {
  void publish(event, payload);
}

// ── Order Events ──

export const notifyEvent = {
  orderCreated(data: {
    orderId: string;
    organizationId: string;
    orderNumber: string;
    customerName: string;
    amount: string;
    triggeredBy?: string;
  }) {
    fire('order:created', data);
  },

  orderStatusChanged(data: {
    orderId: string;
    organizationId: string;
    orderNumber: string;
    status: string;
    triggeredBy?: string;
  }) {
    fire('order:status-changed', { ...data, newStatus: data.status });
  },

  // ── Inventory Events ──

  stockAdjusted(data: { organizationId: string; count: number; actorName: string; triggeredBy?: string }) {
    fire('stock:adjusted', data);
  },

  stockLow(data: { organizationId: string; productId: string; productName: string; quantity: number }) {
    fire('stock:low', data);
  },

  // ── Purchase Events ──

  purchaseReceived(data: {
    purchaseId: string;
    invoiceNumber: string;
    organizationId: string;
    supplierId?: string;
    supplierName?: string;
    totalAmount?: number;
    branchId?: string;
    triggeredBy?: string;
  }) {
    fire('purchase:received', data);
  },

  // ── Return Events ──

  returnCreated(data: {
    returnId: string;
    orderId: string;
    returnNumber: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('return:created', data);
  },

  returnApproved(data: { returnId: string; returnNumber: string; organizationId: string; triggeredBy?: string }) {
    fire('return:approved', data);
  },

  returnReceived(data: { returnId: string; returnNumber: string; organizationId: string; triggeredBy?: string }) {
    fire('return:received', data);
  },

  returnInspected(data: {
    returnId: string;
    returnNumber: string;
    result: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('return:inspected', data);
  },

  returnRefunded(data: {
    returnId: string;
    returnNumber: string;
    amount: number;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('return:refunded', data);
  },

  returnRejected(data: {
    returnId: string;
    returnNumber: string;
    reason: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('return:rejected', data);
  },
};

export default notifyEvent;
