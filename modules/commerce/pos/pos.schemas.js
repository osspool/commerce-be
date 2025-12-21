/**
 * POS Schemas - Simplified
 *
 * 6 endpoints, clean and focused.
 */

// ============================================
// CATALOG SCHEMAS
// ============================================

export const posProductsSchema = {
  querystring: {
    type: 'object',
    properties: {
      // Branch selection
      branchId: { type: 'string', description: 'Branch ID (uses default if omitted)' },

      // Filtering
      category: { type: 'string', description: 'Filter by category' },
      search: { type: 'string', description: 'Search name, SKU, or barcode' },
      inStockOnly: { type: 'boolean', description: 'Only products with stock > 0' },
      lowStockOnly: { type: 'boolean', description: 'Only products at/below reorder point' },

      // Pagination (MongoKit)
      after: { type: 'string', description: 'Cursor for next page (keyset)' },
      limit: { type: 'number', description: 'Items per page (default: 50, max: 100)' },
      sort: { type: 'string', description: 'Sort: name, -createdAt, basePrice' },
    },
  },
};

export const lookupSchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Barcode or SKU' },
      branchId: { type: 'string', description: 'Branch for stock check' },
    },
    required: ['code'],
  },
};

// ============================================
// ORDER SCHEMAS
// ============================================

export const createOrderSchema = {
  body: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // Accept ObjectId-like objects (tests/internal callers) but FE should send string
            productId: { anyOf: [{ type: 'string' }, { type: 'object' }] },
            variantSku: { type: 'string' },
            quantity: { type: 'number', minimum: 1 },
            // Client may send for UI display; server computes and persists price.
            price: { type: 'number' },
          },
          required: ['productId', 'quantity'],
        },
        minItems: 1,
      },
      branchId: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'Branch ID' },
      customer: {
        type: 'object',
        properties: {
          id: { anyOf: [{ type: 'string' }, { type: 'object' }] },
          name: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      payment: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['cash', 'bkash', 'nagad', 'card'] },
          amount: { type: 'number' },
          reference: { type: 'string' },
        },
      },
      discount: { type: 'number', default: 0 },
      deliveryMethod: { type: 'string', enum: ['pickup', 'delivery'], default: 'pickup' },
      deliveryPrice: { type: 'number' },
      deliveryAddress: {
        type: 'object',
        properties: {
          recipientName: { type: 'string' },
          addressLine1: { type: 'string' },
          city: { type: 'string' },
          recipientPhone: { type: 'string' },
        },
      },
      notes: { type: 'string' },
      terminalId: { type: 'string' },
      idempotencyKey: { type: 'string', description: 'Optional idempotency key for safely retrying create-order', maxLength: 200 },
    },
    required: ['items'],
  },
};

export const receiptSchema = {
  params: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
    },
    required: ['orderId'],
  },
};

// ============================================
// STOCK ADJUSTMENT SCHEMA
// ============================================

export const adjustStockSchema = {
  body: {
    type: 'object',
    properties: {
      // Single item adjustment
      productId: { type: 'string', description: 'Product ID (for single adjustment)' },
      variantSku: { type: 'string', description: 'Variant SKU (optional)' },
      quantity: { type: 'number', description: 'Quantity (for single adjustment)' },
      mode: { type: 'string', enum: ['set', 'add', 'remove'], default: 'set' },

      // Bulk adjustments
      adjustments: {
        type: 'array',
        description: 'Bulk adjustments (use instead of single fields)',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            variantSku: { type: 'string' },
            quantity: { type: 'number' },
            mode: { type: 'string', enum: ['set', 'add', 'remove'], default: 'set' },
            reason: { type: 'string' },
          },
          required: ['productId', 'quantity'],
        },
        maxItems: 500,
      },

      // Common fields
      branchId: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'Branch ID (uses default if omitted)' },
      reason: { type: 'string', description: 'Reason for adjustment' },
    },
  },
};

export default {
  posProductsSchema,
  lookupSchema,
  createOrderSchema,
  receiptSchema,
  adjustStockSchema,
};

