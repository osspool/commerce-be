import { StockEntry } from './models/index.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Stock CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - reservedQuantity: systemManaged (updated by order system)
 */
const crudSchemas = buildCrudSchemasFromModel(StockEntry, {
  strictAdditionalProperties: true,
  fieldRules: {
    reservedQuantity: { systemManaged: true },
  },
  query: {
    filterableFields: {
      product: 'ObjectId',
      variantSku: 'string',
      branch: 'ObjectId',
      quantity: 'number',
    },
  },
});

// Export schema options for controller
export const stockSchemaOptions = {
  query: {
    allowedPopulate: ['product', 'branch'],
    filterableFields: {
      product: 'ObjectId',
      variantSku: 'string',
      branch: 'ObjectId',
      quantity: 'number',
    },
  },
};

/**
 * Adjustment Schema
 *
 * User-controlled transaction creation via lostAmount param:
 * - lostAmount not provided → Only creates StockMovement (audit only)
 * - lostAmount provided → Also creates expense transaction for inventory loss
 */
export const adjustmentSchema = {
  body: {
    type: 'object',
    properties: {
      // Single item adjustment
      productId: { type: 'string', description: 'Product ID (for single item)' },
      variantSku: { type: 'string', nullable: true, description: 'Variant SKU' },
      quantity: { type: 'number', description: 'Target quantity or adjustment amount' },
      mode: {
        type: 'string',
        enum: ['set', 'add', 'remove'],
        default: 'set',
        description: 'set: absolute value, add: increase, remove: decrease',
      },
      reason: { type: 'string', description: 'Reason for adjustment (damaged, lost, recount, etc.)' },

      // Bulk adjustments
      adjustments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            variantSku: { type: 'string', nullable: true },
            quantity: { type: 'number' },
            mode: { type: 'string', enum: ['set', 'add', 'remove'] },
            reason: { type: 'string' },
          },
          required: ['productId', 'quantity'],
        },
        description: 'Bulk adjustments (alternative to single item)',
      },

      branchId: { type: 'string', description: 'Branch ID (defaults to main branch)' },

      // User-controlled transaction (Stripe pattern)
      lostAmount: {
        type: 'number',
        minimum: 0,
        description: 'Create expense transaction for this amount. If not provided, only stock is adjusted (no transaction).',
      },
      transactionData: {
        type: 'object',
        description: 'Transaction details (only used if lostAmount is provided)',
        properties: {
          paymentMethod: {
            type: 'string',
            enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer'],
            default: 'cash',
          },
          reference: { type: 'string', description: 'Reference ID' },
        },
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
        message: { type: 'string' },
        transaction: {
          type: 'object',
          nullable: true,
          properties: {
            _id: { type: 'string' },
            amount: { type: 'number' },
            category: { type: 'string' },
          },
        },
      },
    },
  },
};

export default crudSchemas;
