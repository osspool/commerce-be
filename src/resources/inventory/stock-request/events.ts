/**
 * Stock Request Events
 *
 * Domain events emitted by the stock-request submodule.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface StockRequestCreatedPayload {
  requestId: string;
  requestNumber: string;
  requestingBranchId: string;
  priority?: string;
  itemCount?: number;
  totalQuantityRequested?: number;
  requestedBy?: string;
}

interface StockRequestApprovedPayload {
  requestId: string;
  requestNumber?: string;
  approvedBy?: string;
  totalQuantityApproved?: number;
  reviewNotes?: string;
}

interface StockRequestRejectedPayload {
  requestId: string;
  requestNumber?: string;
  rejectedBy?: string;
  reason?: string;
}

interface StockRequestFulfilledPayload {
  requestId: string;
  requestNumber?: string;
  transferId: string;
  documentNumber?: string;
  fulfilledBy?: string;
  isPartial?: boolean;
}

interface StockRequestCancelledPayload {
  requestId: string;
  requestNumber?: string;
  reason?: string;
  cancelledBy?: string;
}

// --- Event Definitions ---

export const StockRequestCreated = defineEvent<StockRequestCreatedPayload>({
  name: 'stock-request:created',
  description: 'Stock request submitted by branch',
  schema: {
    type: 'object',
    required: ['requestId', 'requestNumber', 'requestingBranchId'],
    properties: {
      requestId: { type: 'string' },
      requestNumber: { type: 'string' },
      requestingBranchId: { type: 'string' },
      priority: { type: 'string' },
      itemCount: { type: 'number' },
      totalQuantityRequested: { type: 'number' },
      requestedBy: { type: 'string' },
    },
  },
});

export const StockRequestApproved = defineEvent<StockRequestApprovedPayload>({
  name: 'stock-request:approved',
  description: 'Stock request approved by head office',
  schema: {
    type: 'object',
    required: ['requestId'],
    properties: {
      requestId: { type: 'string' },
      requestNumber: { type: 'string' },
      approvedBy: { type: 'string' },
      totalQuantityApproved: { type: 'number' },
      reviewNotes: { type: 'string' },
    },
  },
});

export const StockRequestRejected = defineEvent<StockRequestRejectedPayload>({
  name: 'stock-request:rejected',
  description: 'Stock request rejected by head office',
  schema: {
    type: 'object',
    required: ['requestId'],
    properties: {
      requestId: { type: 'string' },
      requestNumber: { type: 'string' },
      rejectedBy: { type: 'string' },
      reason: { type: 'string' },
    },
  },
});

export const StockRequestFulfilled = defineEvent<StockRequestFulfilledPayload>({
  name: 'stock-request:fulfilled',
  description: 'Stock request fulfilled - transfer created',
  schema: {
    type: 'object',
    required: ['requestId', 'transferId'],
    properties: {
      requestId: { type: 'string' },
      requestNumber: { type: 'string' },
      transferId: { type: 'string' },
      documentNumber: { type: 'string' },
      fulfilledBy: { type: 'string' },
      isPartial: { type: 'boolean' },
    },
  },
});

export const StockRequestCancelled = defineEvent<StockRequestCancelledPayload>({
  name: 'stock-request:cancelled',
  description: 'Stock request cancelled',
  schema: {
    type: 'object',
    required: ['requestId'],
    properties: {
      requestId: { type: 'string' },
      requestNumber: { type: 'string' },
      reason: { type: 'string' },
      cancelledBy: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(StockRequestCreated);
eventRegistry.register(StockRequestApproved);
eventRegistry.register(StockRequestRejected);
eventRegistry.register(StockRequestFulfilled);
eventRegistry.register(StockRequestCancelled);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'stock-request:created': StockRequestCreated,
  'stock-request:approved': StockRequestApproved,
  'stock-request:rejected': StockRequestRejected,
  'stock-request:fulfilled': StockRequestFulfilled,
  'stock-request:cancelled': StockRequestCancelled,
};

export const handlers: Record<string, never> = {};

export default events;
