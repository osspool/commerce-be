/**
 * Transfer Events
 *
 * Domain events emitted by the transfer submodule.
 */

export const events = {
  'transfer:created': {
    module: 'inventory/transfer',
    description: 'Stock transfer created (draft status)',
    schema: {
      type: 'object',
      required: ['transferId', 'challanNumber'],
      properties: {
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        senderBranchId: { type: 'string' },
        receiverBranchId: { type: 'string' },
        transferType: { type: 'string' },
        itemCount: { type: 'number' },
        totalQuantity: { type: 'number' },
      },
    },
  },

  'transfer:approved': {
    module: 'inventory/transfer',
    description: 'Transfer approved by head office',
    schema: {
      type: 'object',
      required: ['transferId'],
      properties: {
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        approvedBy: { type: 'string' },
      },
    },
  },

  'transfer:dispatched': {
    module: 'inventory/transfer',
    description: 'Transfer dispatched - stock decremented from sender',
    schema: {
      type: 'object',
      required: ['transferId', 'senderBranchId'],
      properties: {
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        senderBranchId: { type: 'string' },
        items: { type: 'array' },
        dispatchedBy: { type: 'string' },
        transport: { type: 'object' },
      },
    },
  },

  'transfer:received': {
    module: 'inventory/transfer',
    description: 'Transfer received - stock incremented at receiver',
    schema: {
      type: 'object',
      required: ['transferId', 'receiverBranchId'],
      properties: {
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        receiverBranchId: { type: 'string' },
        items: { type: 'array' },
        receivedBy: { type: 'string' },
        isPartial: { type: 'boolean' },
      },
    },
  },

  'transfer:cancelled': {
    module: 'inventory/transfer',
    description: 'Transfer cancelled',
    schema: {
      type: 'object',
      required: ['transferId'],
      properties: {
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        reason: { type: 'string' },
        cancelledBy: { type: 'string' },
        wasDispatched: { type: 'boolean' },
      },
    },
  },
};

export const handlers = {};

export default events;
