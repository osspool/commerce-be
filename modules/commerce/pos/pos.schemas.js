/**
 * POS Schemas
 *
 * Centralized schema definitions for all POS routes.
 * Organized by domain: orders, inventory, branches.
 */

// ============================================
// COMMON SCHEMAS
// ============================================

const productIdParam = {
  type: 'object',
  properties: {
    productId: { type: 'string' },
  },
  required: ['productId'],
};

const branchIdQuery = {
  type: 'object',
  properties: {
    branchId: { type: 'string' },
  },
};

// ============================================
// ORDER SCHEMAS
// ============================================

export const lookupSchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Barcode or SKU to search' },
    },
    required: ['code'],
  },
};

export const createOrderSchema = {
  body: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            variantSku: { type: 'string' },
            quantity: { type: 'number', minimum: 1 },
            price: { type: 'number' },
          },
          required: ['productId', 'quantity', 'price'],
        },
      },
      customer: {
        type: 'object',
        properties: {
          id: { type: 'string' },
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
      discount: { type: 'number' },
      notes: { type: 'string' },
      branchId: { type: 'string' },
      terminalId: { type: 'string' },
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
// INVENTORY SCHEMAS
// ============================================

export const getProductStockSchema = {
  params: productIdParam,
  querystring: branchIdQuery,
};

export const setStockSchema = {
  params: productIdParam,
  body: {
    type: 'object',
    properties: {
      variantSku: { type: 'string' },
      branchId: { type: 'string' },
      quantity: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
    },
    required: ['quantity'],
  },
};

export const lowStockSchema = {
  querystring: {
    type: 'object',
    properties: {
      branchId: { type: 'string' },
      threshold: { type: 'number' },
    },
  },
};

export const movementsSchema = {
  querystring: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      branchId: { type: 'string' },
      type: { type: 'string' },
      startDate: { type: 'string' },
      endDate: { type: 'string' },
      page: { type: 'number' },
      limit: { type: 'number' },
    },
  },
};

export const bulkAdjustSchema = {
  body: {
    type: 'object',
    properties: {
      adjustments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', description: 'Product ID' },
            variantSku: { type: 'string', description: 'Variant SKU (optional for simple products)' },
            quantity: { type: 'number', description: 'Quantity to set/add/remove' },
            mode: { type: 'string', enum: ['set', 'add', 'remove'], default: 'set' },
            reason: { type: 'string', description: 'Reason for adjustment' },
            barcode: { type: 'string', description: 'Barcode to assign (optional)' },
          },
          required: ['productId', 'quantity'],
        },
        maxItems: 500,
      },
      branchId: { type: 'string', description: 'Target branch (uses default if not specified)' },
      reason: { type: 'string', description: 'Default reason for all adjustments' },
    },
    required: ['adjustments'],
  },
};

export const updateBarcodeSchema = {
  body: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      variantSku: { type: 'string', description: 'Variant SKU (optional for simple products)' },
      barcode: { type: 'string' },
    },
    required: ['productId', 'barcode'],
  },
};

export const labelDataSchema = {
  querystring: {
    type: 'object',
    properties: {
      productIds: { type: 'string', description: 'Comma-separated product IDs' },
      variantSkus: { type: 'string', description: 'Comma-separated variant SKUs' },
      branchId: { type: 'string' },
    },
  },
};

// ============================================
// GROUPED EXPORTS
// ============================================

export const orderSchemas = {
  lookup: lookupSchema,
  create: createOrderSchema,
  receipt: receiptSchema,
};

export const inventorySchemas = {
  getStock: getProductStockSchema,
  setStock: setStockSchema,
  lowStock: lowStockSchema,
  movements: movementsSchema,
  bulkAdjust: bulkAdjustSchema,
  updateBarcode: updateBarcodeSchema,
  labelData: labelDataSchema,
};

export default {
  order: orderSchemas,
  inventory: inventorySchemas,
};

