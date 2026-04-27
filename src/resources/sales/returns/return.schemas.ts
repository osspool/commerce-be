/**
 * Return Schemas — auto-generated from Mongoose model + manual create body
 * (Zod v4). Arc auto-converts Zod via `z.toJSONSchema()` at registration.
 *
 * The model-derived shapes (params, listQuery, entitySchema) come from
 * `buildCrudSchemasFromModel` because they need to track the Mongoose model
 * exactly. The create body is hand-written — the request shape diverges
 * from the model (service resolves branch/customer/returnWindow from the
 * order).
 */

import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import { z } from 'zod';
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

const reasonEnum = z.enum(['defective', 'wrong_item', 'damaged', 'changed_mind', 'quality', 'other']);

const createItem = z.object({
  productId: z.string(),
  variantSku: z.string().optional(),
  quantity: z.number().min(1),
  reason: reasonEnum,
});

// Manual create schema — request body diverges from the model shape (the
// service resolves branch, customer, returnWindow from the order).
const createBody = z.object({
  orderId: z.string(),
  items: z.array(createItem).min(1),
  notes: z.string().optional(),
  refundMethod: z.enum(['original', 'store_credit']).optional(),
  windowDays: z.number().min(1).optional(),
});

const crudSchemas = {
  create: { body: createBody },
  get: { params: schemaParts.params },
  list: { querystring: schemaParts.listQuery },
};

export default crudSchemas;

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

// Action body schemas — Stripe pattern for state transitions. Imported
// by return.actions.ts.
const inspectionResult = z.object({
  productId: z.string(),
  variantSku: z.string().optional(),
  result: z.enum(['approved', 'partial', 'rejected']),
  refundAmount: z.number().optional(),
});

export const shipActionSchema = z.object({
  provider: z.string().optional(),
  trackingNumber: z.string().optional(),
});

export const inspectActionSchema = z.object({
  results: z.array(inspectionResult),
});

export const reasonActionSchema = z.object({ reason: z.string().optional() });
