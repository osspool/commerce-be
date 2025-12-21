/**
 * Purchase Validation Schemas
 *
 * JSON Schema definitions for purchase (stock entry) API endpoints.
 */

const purchaseItemSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string', description: 'Product ID' },
    variantSku: { type: 'string', nullable: true, description: 'Variant SKU (null for simple products)' },
    // Allow quantity=0 for cost-only corrections (service supports this).
    quantity: { type: 'integer', minimum: 0, description: 'Quantity to add (0 allowed for cost-only correction when costPrice is provided)' },
    costPrice: { type: 'number', minimum: 0, description: 'Cost price per unit' },
  },
  required: ['productId', 'quantity'],
};

// Record Purchase
export const recordPurchaseSchema = {
  body: {
    type: 'object',
    properties: {
      branchId: {
        type: 'string',
        description: 'Head office branch ID (optional - defaults to head office)',
      },
      items: {
        type: 'array',
        items: purchaseItemSchema,
        minItems: 1,
        description: 'Items to add to stock',
      },
      purchaseOrderNumber: {
        type: 'string',
        description: 'Purchase order reference number',
      },
      supplierName: {
        type: 'string',
        description: 'Supplier name',
      },
      supplierInvoice: {
        type: 'string',
        description: 'Supplier invoice number',
      },
      notes: {
        type: 'string',
        description: 'Additional notes',
      },
      // User-controlled transaction creation (Stripe pattern)
      createTransaction: {
        type: 'boolean',
        default: false,
        description: 'Create expense transaction for accounting. Default: false (manufacturing/homemade products typically skip this)',
      },
      transactionData: {
        type: 'object',
        description: 'Transaction details (only used if createTransaction: true)',
        properties: {
          paymentMethod: {
            type: 'string',
            enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'],
            default: 'cash',
          },
          reference: {
            type: 'string',
            description: 'Payment reference (e.g., bank transfer ID)',
          },
          accountNumber: {
            type: 'string',
            description: 'Bank account number (for bank transfers)',
          },
          walletNumber: {
            type: 'string',
            description: 'Mobile wallet number (for MFS payments)',
          },
        },
      },
    },
    required: ['items'],
  },
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        branch: { type: 'object' },
        items: { type: 'array' },
        summary: { type: 'object' },
        errors: { type: 'array' },
        transaction: { type: 'object', nullable: true },
      },
    },
  },
};

// Add Single Stock Item
export const addStockSchema = {
  body: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      variantSku: { type: 'string', nullable: true },
      quantity: { type: 'integer', minimum: 1 },
      costPrice: { type: 'number', minimum: 0 },
      branchId: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['productId', 'quantity'],
  },
};

// Get Purchase History
export const purchaseHistorySchema = {
  querystring: {
    type: 'object',
    properties: {
      branchId: { type: 'string' },
      productId: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
};
