/**
 * Replenishment rule schemas — Zod v4.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => schema;

const listData = <T extends z.ZodType>(schema: T) =>
  z.object({ data: z.array(schema), total: z.number() });

const ruleEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  skuRef: z.string(),
  scope: z.enum(['node', 'location']),
  scopeId: z.string(),
  reorderPoint: z.number(),
  targetLevel: z.number(),
  minOrderQty: z.number().optional(),
  maxOrderQty: z.number().optional(),
  multipleOf: z.number().optional(),
  leadTimeDays: z.number().optional(),
  safetyStock: z.number().optional(),
  preferredSourceId: z.string().optional(),
  isActive: z.boolean(),
});

export const replenishmentSchemas = {
  create: {
    body: z.object({
      skuRef: z.string().describe('SKU to monitor'),
      scope: z.enum(['node', 'location']).describe('Rule applies to node or location'),
      scopeId: z.string().describe('Node or location ID'),
      reorderPoint: z.number().min(0).describe('Trigger replenishment below this level'),
      targetLevel: z.number().min(1).describe('Order up to this level'),
      minOrderQty: z.number().optional(),
      maxOrderQty: z.number().optional(),
      multipleOf: z.number().optional().describe('Round order qty to multiple of this'),
      leadTimeDays: z.number().optional(),
      safetyStock: z.number().optional(),
      preferredSourceId: z.string().optional().describe('Preferred vendor/source node'),
    }),
    response: { 201: successData(ruleEntity) },
  },
  list: {
    querystring: z.object({
      skuRef: z.string().optional(),
      scopeId: z.string().optional(),
      isActive: z.coerce.boolean().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    response: { 200: listData(ruleEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      reorderPoint: z.number().min(0).optional(),
      targetLevel: z.number().min(1).optional(),
      minOrderQty: z.number().optional(),
      maxOrderQty: z.number().optional(),
      multipleOf: z.number().optional(),
      leadTimeDays: z.number().optional(),
      safetyStock: z.number().optional(),
      preferredSourceId: z.string().optional(),
      isActive: z.boolean().optional(),
    }),
  },
  evaluate: {
    body: z.object({
      skuRef: z.string().optional().describe('Evaluate specific SKU (or all if omitted)'),
      nodeId: z.string().optional().describe('Evaluate for specific node'),
      dryRun: z.boolean().optional().describe('Preview triggers without creating orders'),
    }),
  },
};
