/**
 * Transaction Schemas — field rules and filtering for Arc's pipeline,
 * plus action and report querystring shapes (Zod v4).
 *
 * The Mongoose model is owned by @classytic/revenue v2.
 * Arc auto-converts Zod via `z.toJSONSchema()` at registration.
 */

import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { Model } from 'mongoose';
import { z } from 'zod';

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

// ──────────────────────────────────────────────────────────────────
// Action and report schemas — Zod v4. Arc auto-converts at registration.
// ──────────────────────────────────────────────────────────────────

export const verifyActionSchema = z.object({
  verifiedBy: z.string().optional(),
  notes: z.string().optional(),
});

export const refundActionSchema = z.object({
  amount: z.number().min(1).optional(),
  reason: z.string().min(3).optional(),
});

export const holdActionSchema = z.object({
  amount: z.number().optional(),
  reason: z.string().optional(),
  holdUntil: z.string().optional(),
});

export const releaseActionSchema = z.object({
  recipientId: z.string().optional(),
  recipientType: z.string().optional(),
  amount: z.number().optional(),
  reason: z.string().optional(),
});

export const splitActionSchema = z.object({
  rules: z.array(z.unknown()).optional(),
});

export const statementQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  branchId: z.string().optional(),
  source: z.enum(['web', 'pos', 'api']).optional(),
  status: z.string().optional(),
  format: z.enum(['csv', 'json']).optional(),
});

export const profitLossQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const categoriesReportQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  type: z.enum(['income', 'expense']).optional(),
  limit: z.coerce.number().int().optional(),
});

export const cashFlowQuerySchema = z.object({
  months: z.coerce.number().int().max(12).optional(),
});
