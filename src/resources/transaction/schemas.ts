/**
 * Transaction Schemas — field rules and filtering for Arc's pipeline.
 *
 * The Mongoose model is owned by @classytic/revenue v2.
 * This file only defines Arc-specific presentation rules.
 */

import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { Model } from 'mongoose';

export const transactionSchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    publicId: { immutable: true },
    customerId: { immutable: true },
    sourceId: { immutable: true },
    sourceModel: { immutable: true },
    flow: { immutable: true },
    type: { immutable: true },
    gateway: { systemManaged: true },
    webhook: { systemManaged: true },
    verifiedAt: { systemManaged: true },
    verifiedBy: { systemManaged: true },
    hold: { systemManaged: true },
    splits: { systemManaged: true },
    commission: { systemManaged: true },
    metadata: { systemManaged: true },
  },
  create: {
    optionalOverrides: { type: true, status: true },
  },
  query: {
    allowedPopulate: ['relatedTransactionId', 'branch', 'handledBy'],
    filterableFields: {
      publicId: { type: 'string' },
      customerId: { type: 'string' },
      sourceId: { type: 'string' },
      sourceModel: { type: 'string' },
      flow: { type: 'string' },
      type: { type: 'string' },
      method: { type: 'string' },
      status: { type: 'string' },
      date: { type: 'string', format: 'date-time' },
      source: { type: 'string' },
      branch: { type: 'string' },
    },
  },
  filter: {
    selectForRole: {
      user: '-webhook -metadata -gateway.verificationData',
      admin: '-webhook.data',
    },
  },
};

export function buildTransactionCrudSchemas(model: Model<any>): Partial<ReturnType<typeof buildCrudSchemasFromModel>> {
  const { query: _query, ...crudOptions } = transactionSchemaOptions;
  return buildCrudSchemasFromModel(model, crudOptions);
}
