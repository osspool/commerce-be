/**
 * Transfer Events
 *
 * Domain events emitted by the transfer submodule.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface TransferCreatedPayload {
  transferId: string;
  documentNumber: string;
  senderBranchId?: string;
  receiverBranchId?: string;
  transferType?: string;
  itemCount?: number;
  totalQuantity?: number;
}

interface TransferApprovedPayload {
  transferId: string;
  documentNumber?: string;
  approvedBy?: string;
}

interface TransferDispatchedPayload {
  transferId: string;
  documentNumber?: string;
  senderBranchId: string;
  items?: unknown[];
  dispatchedBy?: string;
  transport?: Record<string, unknown>;
}

interface TransferReceivedPayload {
  transferId: string;
  documentNumber?: string;
  receiverBranchId: string;
  items?: unknown[];
  receivedBy?: string;
  isPartial?: boolean;
}

interface TransferCancelledPayload {
  transferId: string;
  documentNumber?: string;
  reason?: string;
  cancelledBy?: string;
  wasDispatched?: boolean;
}

// --- Event Definitions ---

export const TransferCreated = defineEvent<TransferCreatedPayload>({
  name: 'transfer:created',
  description: 'Stock transfer created (draft status)',
  schema: {
    type: 'object',
    required: ['transferId', 'documentNumber'],
    properties: {
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      senderBranchId: { type: 'string' },
      receiverBranchId: { type: 'string' },
      transferType: { type: 'string' },
      itemCount: { type: 'number' },
      totalQuantity: { type: 'number' },
    },
  },
});

export const TransferApproved = defineEvent<TransferApprovedPayload>({
  name: 'transfer:approved',
  description: 'Transfer approved by head office',
  schema: {
    type: 'object',
    required: ['transferId'],
    properties: {
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      approvedBy: { type: 'string' },
    },
  },
});

export const TransferDispatched = defineEvent<TransferDispatchedPayload>({
  name: 'transfer:dispatched',
  description: 'Transfer dispatched - stock decremented from sender',
  schema: {
    type: 'object',
    required: ['transferId', 'senderBranchId'],
    properties: {
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      senderBranchId: { type: 'string' },
      items: { type: 'array' },
      dispatchedBy: { type: 'string' },
      transport: { type: 'object' },
    },
  },
});

export const TransferReceived = defineEvent<TransferReceivedPayload>({
  name: 'transfer:received',
  description: 'Transfer received - stock incremented at receiver',
  schema: {
    type: 'object',
    required: ['transferId', 'receiverBranchId'],
    properties: {
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      receiverBranchId: { type: 'string' },
      items: { type: 'array' },
      receivedBy: { type: 'string' },
      isPartial: { type: 'boolean' },
    },
  },
});

export const TransferCancelled = defineEvent<TransferCancelledPayload>({
  name: 'transfer:cancelled',
  description: 'Transfer cancelled',
  schema: {
    type: 'object',
    required: ['transferId'],
    properties: {
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      reason: { type: 'string' },
      cancelledBy: { type: 'string' },
      wasDispatched: { type: 'boolean' },
    },
  },
});

// --- Registry ---

eventRegistry.register(TransferCreated);
eventRegistry.register(TransferApproved);
eventRegistry.register(TransferDispatched);
eventRegistry.register(TransferReceived);
eventRegistry.register(TransferCancelled);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'transfer:created': TransferCreated,
  'transfer:approved': TransferApproved,
  'transfer:dispatched': TransferDispatched,
  'transfer:received': TransferReceived,
  'transfer:cancelled': TransferCancelled,
};

export const handlers: Record<string, never> = {};

export default events;
