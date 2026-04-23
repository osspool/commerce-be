/**
 * Lot/serial tracking schemas — Zod v4.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

const successData = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });

const listData = <T extends z.ZodType>(schema: T) =>
  z.object({ success: z.literal(true), data: z.array(schema), total: z.number() });

const lotEntity = z.object({
  _id: z.string(),
  organizationId: z.string(),
  skuRef: z.string(),
  trackingType: z.enum(['lot', 'serial']),
  lotCode: z.string().optional(),
  serialCode: z.string().optional(),
  status: z.enum(['active', 'recalled', 'expired']),
  manufacturedAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  vendorBatchRef: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const lotSchemas = {
  create: {
    body: z.object({
      skuRef: z.string().describe('SKU reference'),
      trackingType: z.enum(['lot', 'serial']).describe('Lot = batch, serial = individual unit'),
      lotCode: z.string().optional().describe('Batch/lot code (required for lot type)'),
      serialCode: z.string().optional().describe('Serial number (required for serial type)'),
      manufacturedAt: z.string().datetime().optional(),
      receivedAt: z.string().datetime().optional(),
      expiresAt: z.string().datetime().optional(),
      vendorBatchRef: z.string().optional().describe('Vendor batch reference'),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    response: { 201: successData(lotEntity) },
  },
  list: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU'),
      trackingType: z.enum(['lot', 'serial']).optional(),
      status: z.enum(['active', 'recalled', 'expired']).optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
    response: { 200: listData(lotEntity) },
  },
  update: {
    params: idParam,
    body: z.object({
      status: z.enum(['active', 'recalled', 'expired']).optional(),
      expiresAt: z.string().datetime().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  },
};
