/**
 * Stock Request Validation Schemas
 */

const requestItemSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string', description: 'Product ID' },
    variantSku: { type: 'string', nullable: true },
    quantity: { type: 'integer', minimum: 1, description: 'Quantity requested' },
    notes: { type: 'string' },
  },
  required: ['productId', 'quantity'],
} as const;

const approvedItemSchema = {
  type: 'object',
  properties: {
    itemId: { type: 'string', description: 'Request item ID' },
    productId: { type: 'string', description: 'Product ID (alternative to itemId)' },
    variantSku: { type: 'string', nullable: true },
    quantityApproved: { type: 'integer', minimum: 0, description: 'Approved quantity' },
  },
} as const;

export const createRequestSchema = {
  body: {
    type: 'object',
    properties: {
      requestingBranchId: { type: 'string', description: 'Branch requesting stock' },
      items: {
        type: 'array',
        items: requestItemSchema,
        minItems: 1,
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'urgent'],
        default: 'normal',
      },
      reason: { type: 'string', description: 'Reason for request' },
      expectedDate: { type: 'string', format: 'date', description: 'When stock is needed' },
      notes: { type: 'string' },
    },
    required: ['requestingBranchId', 'items'],
  },
} as const;

export const approveRequestSchema = {
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
        items: approvedItemSchema,
        description: 'Items with approved quantities (optional - defaults to full request)',
      },
      reviewNotes: { type: 'string' },
    },
  },
} as const;

export const rejectRequestSchema = {
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
      reason: { type: 'string', description: 'Rejection reason' },
    },
    required: ['reason'],
  },
} as const;

export const fulfillRequestSchema = {
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
      documentType: {
        type: 'string',
        enum: ['delivery_note', 'dispatch_note', 'delivery_slip'],
      },
      remarks: { type: 'string' },
      items: {
        type: 'array',
        description: 'Optional fulfilled quantities (defaults to approved quantities)',
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            productId: { type: 'string' },
            variantSku: { type: 'string', nullable: true },
            quantity: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
} as const;

export const cancelRequestSchema = {
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
      reason: { type: 'string' },
    },
  },
} as const;

export const listRequestsSchema = {
  querystring: {
    type: 'object',
    properties: {
      requestingBranch: { type: 'string' },
      fulfillingBranch: { type: 'string' },
      status: { type: 'string' },
      priority: { type: 'string' },
      requestNumber: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sort: { type: 'string', default: '-createdAt' },
    },
  },
} as const;

export const getRequestSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
} as const;
