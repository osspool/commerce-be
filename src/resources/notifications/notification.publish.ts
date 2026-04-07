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

  // ── Transfer Events ──

  transferCreated(data: {
    transferId: string;
    docNumber: string;
    organizationId: string;
    senderBranch?: string;
    receiverBranch?: string;
    triggeredBy?: string;
  }) {
    fire('transfer:created', data);
  },

  transferApproved(data: {
    transferId: string;
    docNumber: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('transfer:approved', data);
  },

  transferDispatched(data: {
    transferId: string;
    docNumber: string;
    organizationId: string;
    senderBranch?: string;
    receiverBranch?: string;
    triggeredBy?: string;
  }) {
    fire('transfer:dispatched', data);
  },

  transferReceived(data: {
    transferId: string;
    docNumber: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('transfer:received', data);
  },

  // ── Inventory Events ──

  stockAdjusted(data: {
    organizationId: string;
    count: number;
    actorName: string;
    triggeredBy?: string;
  }) {
    fire('stock:adjusted', data);
  },

  stockLow(data: {
    organizationId: string;
    productId: string;
    productName: string;
    quantity: number;
  }) {
    fire('stock:low', data);
  },

  // ── Purchase Events ──

  purchaseReceived(data: {
    purchaseId: string;
    invoiceNumber: string;
    organizationId: string;
    triggeredBy?: string;
  }) {
    fire('purchase:received', data);
  },
};

export default notifyEvent;
