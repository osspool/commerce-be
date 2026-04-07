/**
 * Transaction Domain Events
 *
 * Events emitted by the payment/revenue system for transaction lifecycle.
 * Transactions are created by @classytic/revenue library, not manually.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface TransactionCreatedPayload {
  transactionId: string;
  flow: 'inflow' | 'outflow';
  type?: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  sourceId?: string;
  sourceModel?: string;
  gateway?: string;
}

interface TransactionVerifiedPayload {
  transactionId: string;
  sourceId: string;
  amount?: number;
  gateway?: string;
  verifiedBy?: string;
}

interface TransactionFailedPayload {
  transactionId: string;
  sourceId?: string;
  reason: string;
  gateway?: string;
}

interface TransactionRefundedPayload {
  transactionId: string;
  refundAmount: number;
  sourceId?: string;
  reason?: string;
}

// --- Event Definitions ---

export const TransactionCreated = defineEvent<TransactionCreatedPayload>({
  name: 'transaction:created',
  description: 'Emitted when a new payment transaction is created by revenue system',
  schema: {
    type: 'object',
    required: ['transactionId', 'flow', 'amount', 'status'],
    properties: {
      transactionId: { type: 'string', description: 'Transaction ID' },
      flow: { type: 'string', enum: ['inflow', 'outflow'], description: 'Money flow direction' },
      type: { type: 'string', description: 'Transaction category (order_purchase, refund, etc.)' },
      amount: { type: 'number', description: 'Transaction amount' },
      status: {
        type: 'string',
        enum: ['pending', 'completed', 'failed', 'refunded'],
        description: 'Transaction status',
      },
      sourceId: { type: 'string', description: 'Source ID (e.g., order ID)' },
      sourceModel: { type: 'string', description: 'Source model (e.g., Order)' },
      gateway: { type: 'string', description: 'Payment gateway (manual, bkash, etc.)' },
    },
  },
});

export const TransactionVerified = defineEvent<TransactionVerifiedPayload>({
  name: 'transaction:verified',
  description: 'Emitted when a pending payment is verified by admin/webhook',
  schema: {
    type: 'object',
    required: ['transactionId', 'sourceId'],
    properties: {
      transactionId: { type: 'string', description: 'Transaction ID' },
      sourceId: { type: 'string', description: 'Related order/source ID' },
      amount: { type: 'number', description: 'Verified amount' },
      gateway: { type: 'string', description: 'Payment gateway' },
      verifiedBy: { type: 'string', description: 'Admin user ID who verified' },
    },
  },
});

export const TransactionFailed = defineEvent<TransactionFailedPayload>({
  name: 'transaction:failed',
  description: 'Emitted when a transaction fails or is rejected',
  schema: {
    type: 'object',
    required: ['transactionId', 'reason'],
    properties: {
      transactionId: { type: 'string', description: 'Transaction ID' },
      sourceId: { type: 'string', description: 'Related order/source ID' },
      reason: { type: 'string', description: 'Failure reason' },
      gateway: { type: 'string', description: 'Payment gateway' },
    },
  },
});

export const TransactionRefunded = defineEvent<TransactionRefundedPayload>({
  name: 'transaction:refunded',
  description: 'Emitted when a transaction is refunded',
  schema: {
    type: 'object',
    required: ['transactionId', 'refundAmount'],
    properties: {
      transactionId: { type: 'string', description: 'Original transaction ID' },
      refundAmount: { type: 'number', description: 'Refund amount' },
      sourceId: { type: 'string', description: 'Related order ID' },
      reason: { type: 'string', description: 'Refund reason' },
    },
  },
});

// --- Registry ---

eventRegistry.register(TransactionCreated);
eventRegistry.register(TransactionVerified);
eventRegistry.register(TransactionFailed);
eventRegistry.register(TransactionRefunded);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'transaction:created': TransactionCreated,
  'transaction:verified': TransactionVerified,
  'transaction:failed': TransactionFailed,
  'transaction:refunded': TransactionRefunded,
};

export const handlers = {
  // Transaction module doesn't subscribe to events yet
  // Transactions are created by revenue library hooks
};
