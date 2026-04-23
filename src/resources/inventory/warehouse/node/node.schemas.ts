/**
 * Warehouse Node (storage facility) schemas — Zod v4.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

const nodeEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.enum(['active', 'inactive']),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
      coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    })
    .optional(),
  capabilities: z.array(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

export const nodeSchemas = {
  create: {
    body: z.object({
      code: z.string().min(1).describe('Unique code (e.g. WH-01)'),
      name: z.string().min(1).describe('Display name'),
      type: z.enum(['warehouse', 'store', 'fulfillment_center', 'returns_center']).default('warehouse'),
      timezone: z.string().optional(),
      currency: z.string().optional(),
      address: z
        .object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
          coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
        })
        .optional(),
      capabilities: z.array(z.string()).optional(),
      isDefault: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(nodeEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      name: z.string().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      timezone: z.string().optional(),
      address: z
        .object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
          coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
        })
        .optional(),
      capabilities: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  },
};
