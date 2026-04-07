/**
 * Purchase Events
 *
 * Domain events emitted by the purchase submodule.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface PurchaseCreatedPayload {
  purchaseId: string;
  invoiceNumber: string;
  supplierId?: string;
  branchId?: string;
  itemCount?: number;
  grandTotal?: number;
}

interface PurchaseReceivedPayload {
  purchaseId: string;
  branchId: string;
  invoiceNumber?: string;
  items?: unknown[];
  receivedBy?: string;
}

interface PurchasePaidPayload {
  purchaseId: string;
  amount: number;
  invoiceNumber?: string;
  method?: string;
  transactionId?: string;
  paymentStatus?: string;
  remainingDue?: number;
}

interface PurchaseCancelledPayload {
  purchaseId: string;
  invoiceNumber?: string;
  reason?: string;
  cancelledBy?: string;
}

// --- Event Definitions ---

export const PurchaseCreated = defineEvent<PurchaseCreatedPayload>({
  name: 'purchase:created',
  description: 'Purchase invoice created (draft status)',
  schema: {
    type: 'object',
    required: ['purchaseId', 'invoiceNumber'],
    properties: {
      purchaseId: { type: 'string' },
      invoiceNumber: { type: 'string' },
      supplierId: { type: 'string' },
      branchId: { type: 'string' },
      itemCount: { type: 'number' },
      grandTotal: { type: 'number' },
    },
  },
});

export const PurchaseReceived = defineEvent<PurchaseReceivedPayload>({
  name: 'purchase:received',
  description: 'Purchase received - stock added to inventory',
  schema: {
    type: 'object',
    required: ['purchaseId', 'branchId'],
    properties: {
      purchaseId: { type: 'string' },
      invoiceNumber: { type: 'string' },
      branchId: { type: 'string' },
      items: { type: 'array' },
      receivedBy: { type: 'string' },
    },
  },
});

export const PurchasePaid = defineEvent<PurchasePaidPayload>({
  name: 'purchase:paid',
  description: 'Payment made against purchase',
  schema: {
    type: 'object',
    required: ['purchaseId', 'amount'],
    properties: {
      purchaseId: { type: 'string' },
      invoiceNumber: { type: 'string' },
      amount: { type: 'number' },
      method: { type: 'string' },
      transactionId: { type: 'string' },
      paymentStatus: { type: 'string' },
      remainingDue: { type: 'number' },
    },
  },
});

export const PurchaseCancelled = defineEvent<PurchaseCancelledPayload>({
  name: 'purchase:cancelled',
  description: 'Purchase cancelled',
  schema: {
    type: 'object',
    required: ['purchaseId'],
    properties: {
      purchaseId: { type: 'string' },
      invoiceNumber: { type: 'string' },
      reason: { type: 'string' },
      cancelledBy: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(PurchaseCreated);
eventRegistry.register(PurchaseReceived);
eventRegistry.register(PurchasePaid);
eventRegistry.register(PurchaseCancelled);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'purchase:created': PurchaseCreated,
  'purchase:received': PurchaseReceived,
  'purchase:paid': PurchasePaid,
  'purchase:cancelled': PurchaseCancelled,
};

export const handlers: Record<string, never> = {};

export default events;
