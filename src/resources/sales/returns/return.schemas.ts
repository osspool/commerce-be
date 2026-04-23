/**
 * Return Schemas — auto-generated from Mongoose model + manual action schema.
 */

import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { JsonSchema } from '@classytic/repo-core/schema';
import Return from './models/return.model.js';

const schemaParts = buildCrudSchemasFromModel(Return, {
  strictAdditionalProperties: true,
  fieldRules: {
    returnNumber: { systemManaged: true },
    branch: { systemManaged: true },
    customer: { systemManaged: true },
    customerName: { systemManaged: true },
    createdBy: { systemManaged: true },
    status: { systemManaged: true },
    statusHistory: { systemManaged: true },
    moveGroupIds: { systemManaged: true },
    totalRefundAmount: { systemManaged: true },
    inspectedBy: { systemManaged: true },
    inspectedAt: { systemManaged: true },
    returnWindow: { systemManaged: true },
    reverseShipping: { systemManaged: true },
  },
});

// Manual create schema — the request body differs from the model shape
// (service resolves branch, customer, returnWindow from the order)
const createBody = {
  type: 'object',
  required: ['orderId', 'items'],
  additionalProperties: true,
  properties: {
    orderId: { type: 'string', description: 'Order ID (must be delivered)' },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['productId', 'quantity', 'reason'],
        properties: {
          productId: { type: 'string' },
          variantSku: { type: 'string' },
          quantity: { type: 'number', minimum: 1 },
          reason: { type: 'string', enum: ['defective', 'wrong_item', 'damaged', 'changed_mind', 'quality', 'other'] },
        },
      },
    },
    notes: { type: 'string' },
    refundMethod: { type: 'string', enum: ['original', 'store_credit'] },
    windowDays: { type: 'number', minimum: 1 },
  },
};

const crudSchemas: {
  create: { body: unknown };
  get: { params: JsonSchema };
  list: { querystring: JsonSchema };
} = {
  create: { body: createBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
};

export const returnSchemaOptions = {
  query: {
    filterableFields: {
      status: 'string',
      orderId: 'string',
      customer: 'string',
      customerName: 'string',
      branch: 'string',
    },
  },
};

export const returnEntitySchema = ((schemaParts as unknown as Record<string, unknown>).entitySchema as Record<
  string,
  unknown
>) || {
  type: 'object',
  additionalProperties: true,
};

/**
 * Action endpoint schema — Stripe pattern for state transitions.
 */
export const actionSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  body: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['approve', 'ship', 'receive', 'inspect', 'refund', 'reject', 'cancel'],
      },
      provider: { type: 'string' },
      trackingNumber: { type: 'string' },
      reason: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            variantSku: { type: 'string' },
            result: { type: 'string', enum: ['approved', 'partial', 'rejected'] },
            refundAmount: { type: 'number' },
          },
          required: ['productId', 'result'],
        },
      },
    },
  },
};

export default crudSchemas;
