/**
 * Stock audit (cycle count) schemas — Zod v4.
 */
import { z } from 'zod';

const idParam = z.object({ id: z.string() });

export const auditSchemas = {
  create: {
    body: z.object({
      countType: z.enum(['full', 'cycle', 'spot']).describe('Audit type'),
      scope: z
        .object({
          nodeId: z.string().optional().describe('Warehouse to audit'),
          locationId: z.string().optional().describe('Specific location'),
          skuRefs: z.array(z.string()).optional().describe('Specific SKUs'),
        })
        .optional(),
      freezePolicy: z.enum(['hard_freeze', 'soft_freeze', 'none']).optional(),
    }),
  },
  submitLines: {
    params: idParam,
    body: z.object({
      lines: z
        .array(
          z.object({
            skuRef: z.string(),
            locationId: z.string(),
            lotId: z.string().optional(),
            serialCode: z.string().optional(),
            countedQuantity: z.number().min(0),
            varianceReason: z.string().optional(),
          }),
        )
        .min(1),
    }),
  },
  reconcile: {
    params: idParam,
    body: z.object({
      action: z.literal('reconcile'),
      autoApproveThreshold: z.number().min(0).optional().describe('Auto-approve variances within this qty'),
    }),
  },
};
