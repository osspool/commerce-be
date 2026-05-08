/**
 * Standard cost schemas — Zod v4.
 */
import { z } from 'zod';

const successData = <T extends z.ZodType>(schema: T) => schema;

const standardCostEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  skuRef: z.string(),
  standardCost: z.number(),
  currency: z.string(),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().nullable().optional(),
  note: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const standardCostSchemas = {
  list: {
    querystring: z.object({
      skuRef: z.string().optional(),
      activeOnly: z.coerce.boolean().optional(),
      limit: z.coerce.number().min(1).max(500).optional(),
    }),
    response: {
      200: z.object({
        data: z.array(standardCostEntity),
        total: z.number(),
      }),
    },
  },
  getActive: {
    querystring: z.object({ skuRef: z.string() }),
  },
  set: {
    body: z.object({
      skuRef: z.string(),
      standardCost: z.number().nonnegative(),
      currency: z.string(),
      effectiveFrom: z.iso.datetime().optional(),
      note: z.string().optional(),
    }),
    response: { 201: successData(standardCostEntity) },
  },
  recognizeVariance: {
    body: z.object({
      skuRef: z.string(),
      actualCost: z.number().nonnegative(),
      quantity: z.number().positive(),
      referenceType: z.string().optional(),
      referenceId: z.string().optional(),
      occurredAt: z.iso.datetime().optional(),
    }),
  },
};
