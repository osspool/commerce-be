/**
 * Stock Events
 *
 * Domain events emitted by the stock submodule.
 * These events are consumed by other modules for cross-aggregate coordination.
 */

// Event definitions (for documentation & validation)
export const events = {
  'stock:decremented': {
    module: 'inventory/stock',
    description: 'Stock quantity decreased (sale, transfer out, adjustment)',
    schema: {
      type: 'object',
      required: ['productId', 'branchId', 'quantity'],
      properties: {
        productId: { type: 'string' },
        variantSku: { type: 'string', nullable: true },
        branchId: { type: 'string' },
        quantity: { type: 'number' },
        previousQuantity: { type: 'number' },
        newQuantity: { type: 'number' },
        reason: { type: 'string' },
        reference: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            id: { type: 'string' },
          },
        },
      },
    },
  },

  'stock:incremented': {
    module: 'inventory/stock',
    description: 'Stock quantity increased (purchase, transfer in, return)',
    schema: {
      type: 'object',
      required: ['productId', 'branchId', 'quantity'],
      properties: {
        productId: { type: 'string' },
        variantSku: { type: 'string', nullable: true },
        branchId: { type: 'string' },
        quantity: { type: 'number' },
        previousQuantity: { type: 'number' },
        newQuantity: { type: 'number' },
        reason: { type: 'string' },
        reference: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            id: { type: 'string' },
          },
        },
      },
    },
  },

  'stock:adjusted': {
    module: 'inventory/stock',
    description: 'Stock manually adjusted (recount, correction)',
    schema: {
      type: 'object',
      required: ['productId', 'branchId'],
      properties: {
        productId: { type: 'string' },
        variantSku: { type: 'string', nullable: true },
        branchId: { type: 'string' },
        previousQuantity: { type: 'number' },
        newQuantity: { type: 'number' },
        reason: { type: 'string' },
        adjustedBy: { type: 'string' },
      },
    },
  },

  'stock:low': {
    module: 'inventory/stock',
    description: 'Stock fell below reorder point',
    schema: {
      type: 'object',
      required: ['productId', 'branchId', 'quantity', 'reorderPoint'],
      properties: {
        productId: { type: 'string' },
        variantSku: { type: 'string', nullable: true },
        branchId: { type: 'string' },
        quantity: { type: 'number' },
        reorderPoint: { type: 'number' },
        productName: { type: 'string' },
        branchName: { type: 'string' },
      },
    },
  },

  'stock:out': {
    module: 'inventory/stock',
    description: 'Stock reached zero',
    schema: {
      type: 'object',
      required: ['productId', 'branchId'],
      properties: {
        productId: { type: 'string' },
        variantSku: { type: 'string', nullable: true },
        branchId: { type: 'string' },
        productName: { type: 'string' },
        branchName: { type: 'string' },
      },
    },
  },
};

// Event handlers (subscribing to other modules' events)
export const handlers = {
  // Order events
  'order:created': async ({ orderId, items, branchId }) => {
    // Reserved stock when order is created (if using reservation pattern)
    // Currently handled directly in order creation flow
  },

  'order:cancelled': async ({ orderId, items, branchId }) => {
    // Restore stock when order is cancelled
    // Currently handled in order cancellation workflow
  },

  // Product events
  'product:deleted': async ({ productId }) => {
    // Mark stock entries as inactive when product is deleted
    // Preserve for historical reporting
  },

  'product:variant:deactivated': async ({ productId, variantSku }) => {
    // Mark specific variant stock entry as inactive
  },
};

export default events;
