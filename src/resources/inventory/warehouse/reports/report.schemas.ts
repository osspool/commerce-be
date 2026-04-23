/**
 * Inventory report schemas — Zod v4.
 */
import { z } from 'zod';

export const reportSchemas = {
  aging: {
    querystring: z.object({
      nodeId: z.string().optional(),
      skuRef: z.string().optional(),
      buckets: z.string().optional().describe('Comma-separated day boundaries (default: 30,60,90)'),
    }),
  },
  valuation: {
    querystring: z.object({
      mode: z
        .enum(['snapshot', 'layers'])
        .optional()
        .describe('snapshot = quant-based (fast), layers = cost-layer-based (audit-grade)'),
      locationId: z.string().optional().describe('Filter by location'),
      skuRef: z.string().optional().describe('Filter by SKU'),
    }),
  },
  cogs: {
    querystring: z.object({
      startDate: z.string().describe('Period start (ISO 8601)'),
      endDate: z.string().describe('Period end (ISO 8601)'),
      skuRef: z.string().optional().describe('Filter by SKU'),
      locationId: z.string().optional().describe('Filter by source location'),
    }),
  },
  turnover: {
    querystring: z.object({
      periodDays: z.coerce.number().int().min(1).max(365).optional().describe('Lookback period in days (default: 30)'),
    }),
  },
  availability: {
    querystring: z.object({
      nodeId: z.string().optional(),
      skuRefs: z.string().optional().describe('Comma-separated SKU references'),
    }),
  },
  health: {
    querystring: z.object({
      nodeId: z.string().optional(),
    }),
  },
};
