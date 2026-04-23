/**
 * Cost layer / valuation schemas — Zod v4.
 */
import { z } from 'zod';

export const costSchemas = {
  valuation: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU'),
      locationId: z.string().optional().describe('Filter by location'),
      nodeId: z.string().optional().describe('Filter by node'),
    }),
  },
  layers: {
    querystring: z.object({
      skuRef: z.string().describe('SKU reference'),
      locationId: z.string().optional(),
      limit: z.coerce.number().min(1).max(100).optional(),
    }),
  },
};
