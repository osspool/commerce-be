/**
 * Stock package schemas — Zod v4.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => schema;

const packageEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  barcode: z.string(),
  parentPackageId: z.string().optional(),
  locationId: z.string().optional(),
  packageType: z.enum(['reusable', 'disposable']).optional(),
  baseWeight: z.number().optional(),
  maxWeight: z.number().optional(),
  status: z.string().optional(),
});

export const packageSchemas = {
  create: {
    body: z.object({
      barcode: z.string().optional().describe('Barcode (auto-generated if omitted)'),
      locationId: z.string().optional(),
      packageType: z.enum(['reusable', 'disposable']).default('disposable'),
      baseWeight: z.number().optional().describe('Empty weight in grams'),
      maxWeight: z.number().optional().describe('Max weight in grams'),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(packageEntity) },
  },
  list: {
    querystring: z.object({
      locationId: z.string().optional(),
      parentPackageId: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
  nest: {
    params: idParam,
    body: z.object({
      childPackageId: z.string().describe('Package to nest inside this one'),
    }),
  },
  contents: {
    params: idParam,
  },
};
