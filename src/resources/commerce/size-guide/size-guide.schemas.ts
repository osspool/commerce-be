/**
 * Size Guide Schemas — Zod v4. Arc auto-converts via `z.toJSONSchema()`
 * at registration (Fastify validation + OpenAPI).
 */

import { z } from 'zod';

const measurementUnit = z.enum(['inches', 'cm']);

const sizeSchema = z.object({
  name: z.string().min(1).max(20),
  // Free-form per-size measurements: keys are arbitrary measurement
  // labels (e.g. "Chest", "Waist"), values are display strings ("38in").
  measurements: z.record(z.string(), z.string()).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(500).optional(),
  measurementUnit: measurementUnit.optional(),
  measurementLabels: z.array(z.string().min(1).max(50)).max(10).optional(),
  sizes: z.array(sizeSchema).optional(),
  note: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  measurementUnit: measurementUnit.optional(),
  measurementLabels: z.array(z.string().min(1).max(50)).max(10).optional(),
  sizes: z.array(sizeSchema).optional(),
  note: z.string().max(1000).optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().optional(),
});

const schemas = {
  create: { body: createBody },
  update: { body: updateBody },
};

export default schemas;
