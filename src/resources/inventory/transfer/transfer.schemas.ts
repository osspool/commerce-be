/**
 * Transfer Validation Schemas
 *
 * JSON Schema definitions for transfer API endpoints.
 */

const transferItemSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string', description: 'Product ID' },
    variantSku: { type: 'string', nullable: true, description: 'Variant SKU (null for simple products)' },
    cartonNumber: { type: 'string', description: 'Carton number reference' },
    quantity: { type: 'integer', minimum: 1, description: 'Quantity to transfer' },
    costPrice: { type: 'number', minimum: 0, description: 'Cost price per unit' },
    notes: { type: 'string', description: 'Item notes' },
  },
  required: ['productId', 'quantity'],
} as const;

const receivedItemSchema = {
  type: 'object',
  properties: {
    itemId: { type: 'string', description: 'Transfer item ID' },
    productId: { type: 'string', description: 'Product ID (alternative to itemId)' },
    variantSku: { type: 'string', nullable: true },
    quantityReceived: { type: 'integer', minimum: 0, description: 'Quantity actually received' },
  },
} as const;

const transportSchema = {
  type: 'object',
  properties: {
    vehicleNumber: { type: 'string' },
    driverName: { type: 'string' },
    driverPhone: { type: 'string' },
    estimatedArrival: { type: 'string', format: 'date-time' },
    notes: { type: 'string' },
  },
} as const;

// Create Transfer
export const createTransferSchema = {
  body: {
    type: 'object',
    properties: {
      senderBranchId: {
        type: 'string',
        description: 'Head office branch ID (defaults to configured head office if omitted)',
      },
      receiverBranchId: { type: 'string', description: 'Sub-branch ID' },
      items: {
        type: 'array',
        items: transferItemSchema,
        minItems: 1,
        description: 'Items to transfer',
      },
      documentType: {
        type: 'string',
        enum: ['delivery_note', 'dispatch_note', 'delivery_slip'],
        default: 'delivery_note',
      },
      remarks: { type: 'string' },
    },
    required: ['receiverBranchId', 'items'],
  },
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
      },
    },
  },
} as const;

// Update Transfer (draft only)
export const updateTransferSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: transferItemSchema,
        minItems: 1,
      },
      documentType: {
        type: 'string',
        enum: ['delivery_note', 'dispatch_note', 'delivery_slip'],
      },
      remarks: { type: 'string' },
      transport: transportSchema,
    },
  },
} as const;

// Dispatch Transfer
export const dispatchSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      transport: transportSchema,
    },
  },
} as const;

// Receive Transfer
export const receiveSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: receivedItemSchema,
        description: 'Items with received quantities (optional - defaults to full receipt)',
      },
    },
  },
} as const;

// Cancel Transfer
export const cancelSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Cancellation reason' },
    },
  },
} as const;

// List Transfers
export const listTransfersSchema = {
  querystring: {
    type: 'object',
    properties: {
      senderBranch: { type: 'string' },
      receiverBranch: { type: 'string' },
      status: { type: 'string' },
      documentNumber: { type: 'string' },
      documentType: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sort: { type: 'string', default: '-createdAt' },
    },
  },
} as const;

// Get Transfer by ID
export const getTransferSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
} as const;

// Get Transfer by Transfer Number
export const getByDocumentNumberSchema = {
  params: {
    type: 'object',
    properties: {
      documentNumber: { type: 'string' },
    },
    required: ['documentNumber'],
  },
} as const;
