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
      branchId: { type: 'string', description: 'Branch ID (uses default if omitted)' },
      category: { type: 'string', description: 'Filter by category' },
      search: { type: 'string', description: 'Search name, SKU, or barcode' },
      inStockOnly: { type: 'boolean', description: 'Only products with stock > 0' },
      lowStockOnly: { type: 'boolean', description: 'Only products at/below reorder point' },
      page: { type: 'number', description: 'Page number (offset pagination, default: 1)' },
      limit: { type: 'number', description: 'Items per page (default: 20, max: 100)' },
      sort: { type: 'string', description: 'Sort: name, -createdAt, basePrice' },
    },
  },
} as const;

export const lookupSchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Barcode or SKU' },
      branchId: { type: 'string', description: 'Branch for stock check' },
    },
    required: ['code'],
  },
} as const;

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
            productId: { anyOf: [{ type: 'string' }, { type: 'object' }] },
            variantSku: { type: 'string' },
            quantity: { type: 'number', minimum: 1 },
            price: { type: 'number' },
          },
          required: ['productId', 'quantity'],
        },
        minItems: 1,
      },
      branchId: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'Branch ID' },
      branchSlug: { type: 'string', description: 'Branch slug (takes priority over branchId)' },
      customer: {
        type: 'object',
        description: 'Optional if membershipCardId is provided (customer auto-resolved from card)',
        properties: {
          id: { anyOf: [{ type: 'string' }, { type: 'object' }] },
          name: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      payments: {
        type: 'array',
        description: 'Multiple payment methods for split payments',
        items: {
          type: 'object',
          required: ['method', 'amount'],
          properties: {
            method: { type: 'string', enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'] },
            amount: { type: 'number', minimum: 0 },
            reference: { type: 'string' },
            details: {
              type: 'object',
              description: 'Method-specific details (walletNumber, bankName, etc.)',
            },
          },
        },
      },
      discount: { type: 'number', default: 0 },
      deliveryMethod: { type: 'string', enum: ['pickup', 'delivery'], default: 'pickup' },
      deliveryPrice: { type: 'number' },
      deliveryAreaId: { type: 'number', description: 'Logistics area id (optional)' },
      deliveryAddress: {
        type: 'object',
        properties: {
          recipientName: { type: 'string' },
          addressLine1: { type: 'string' },
          addressLine2: { type: 'string' },
          areaName: { type: 'string' },
          city: { type: 'string' },
          recipientPhone: { type: 'string' },
          postalCode: { type: 'string' },
        },
      },
      notes: { type: 'string' },
      terminalId: { type: 'string' },
      idempotencyKey: {
        type: 'string',
        description: 'Optional idempotency key for safely retrying create-order',
        maxLength: 200,
      },
      membershipCardId: {
        type: 'string',
        description: 'Membership card ID (e.g., "MBR-12345678").',
        maxLength: 50,
      },
      pointsToRedeem: {
        type: 'integer',
        minimum: 0,
        description: 'Points to redeem for discount.',
      },
    },
    required: ['items'],
  },
} as const;

export const receiptSchema = {
  params: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
    },
    required: ['orderId'],
  },
} as const;

// Note: stock-adjustment schemas live in the inventory module — POS never
// adjusts stock directly. (See inventory-management.plugin.ts.)

export default {
  posProductsSchema,
  lookupSchema,
  createOrderSchema,
  receiptSchema,
};
