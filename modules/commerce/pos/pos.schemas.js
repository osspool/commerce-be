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

/**
 * Customer Resolution Priority:
 * 1. membershipCardId - Scans card → auto-populates customer name, phone, applies tier discount + points
 * 2. customer.id - Existing customer ID lookup
 * 3. customer.phone - Find or create customer by phone
 * 4. None - Walk-in customer (no customer record)
 *
 * When membershipCardId is provided:
 * - Customer object is NOT needed (auto-populated from membership record)
 * - Tier discount is auto-applied
 * - Points are calculated and awarded on order completion
 */
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
      branchSlug: { type: 'string', description: 'Branch slug (takes priority over branchId)' },

      // Customer identification (optional - use membershipCardId for members)
      customer: {
        type: 'object',
        description: 'Optional if membershipCardId is provided (customer auto-resolved from card)',
        properties: {
          id: { anyOf: [{ type: 'string' }, { type: 'object' }] },
          name: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      // Single payment (backward compatible)
      payment: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'] },
          amount: { type: 'number' },
          reference: { type: 'string' },
        },
      },
      // Split/multi-payment: e.g., 100 cash + 200 bkash + 200 bank
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
      idempotencyKey: { type: 'string', description: 'Optional idempotency key for safely retrying create-order', maxLength: 200 },

      // Membership - scan or enter card ID for instant customer lookup + benefits
      membershipCardId: {
        type: 'string',
        description: 'Membership card ID (e.g., "MBR-12345678"). When provided: customer auto-resolved, tier discount applied, points earned.',
        maxLength: 50,
      },
      // Points redemption (requires membershipCardId)
      pointsToRedeem: {
        type: 'integer',
        minimum: 0,
        description: 'Points to redeem for discount. Capped at platform maxRedeemPercent of order total.',
      },
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

