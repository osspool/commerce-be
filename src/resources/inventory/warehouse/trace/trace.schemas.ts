/**
 * Traceability schemas — Zod v4.
 *
 * Field names (`lotCode`, `skuRef`, `serialCode`) mirror Flow's trace
 * service signatures — never "lotId".
 */
import { z } from 'zod';

export const traceSchemas = {
  traceLot: {
    querystring: z.object({
      lotCode: z.string().describe('Lot code to trace'),
      skuRef: z.string().describe('SKU the lot belongs to'),
    }),
  },
  traceSerial: {
    querystring: z.object({
      serialCode: z.string().describe('Serial code to trace'),
      skuRef: z.string().describe('SKU reference'),
    }),
  },
  recall: {
    body: z.object({
      lotCode: z.string().describe('Lot code to recall'),
      skuRef: z.string().describe('SKU the lot belongs to'),
    }),
  },
};
