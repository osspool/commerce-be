/**
 * Purchase Events
 *
 * Domain events emitted by the purchase submodule.
 */

export const events = {
  'purchase:created': {
    module: 'inventory/purchase',
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
  },

  'purchase:received': {
    module: 'inventory/purchase',
    description: 'Purchase received - stock added to inventory',
    schema: {
      type: 'object',
      required: ['purchaseId', 'branchId'],
      properties: {
        purchaseId: { type: 'string' },
        invoiceNumber: { type: 'string' },
        branchId: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string' },
              variantSku: { type: 'string' },
              quantity: { type: 'number' },
              costPrice: { type: 'number' },
            },
          },
        },
        receivedBy: { type: 'string' },
      },
    },
  },

  'purchase:paid': {
    module: 'inventory/purchase',
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
  },

  'purchase:cancelled': {
    module: 'inventory/purchase',
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
  },
};

export const handlers = {};

export default events;
