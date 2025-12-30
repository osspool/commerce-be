/**
 * Stock Request Events
 *
 * Domain events emitted by the stock-request submodule.
 */

export const events = {
  'stock-request:created': {
    module: 'inventory/stock-request',
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
  },

  'stock-request:approved': {
    module: 'inventory/stock-request',
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
  },

  'stock-request:rejected': {
    module: 'inventory/stock-request',
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
  },

  'stock-request:fulfilled': {
    module: 'inventory/stock-request',
    description: 'Stock request fulfilled - transfer created',
    schema: {
      type: 'object',
      required: ['requestId', 'transferId'],
      properties: {
        requestId: { type: 'string' },
        requestNumber: { type: 'string' },
        transferId: { type: 'string' },
        challanNumber: { type: 'string' },
        fulfilledBy: { type: 'string' },
        isPartial: { type: 'boolean' },
      },
    },
  },

  'stock-request:cancelled': {
    module: 'inventory/stock-request',
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
  },
};

export const handlers = {};

export default events;
