/**
 * Consignment settlement schemas — Zod v4.
 */
import { z } from 'zod';

export const consignmentSchemas = {
  settleMove: {
    params: z.object({ moveId: z.string() }),
  },
  pendingSummary: {
    querystring: z.object({
      skuRef: z.string().optional(),
      ownerRef: z.string().optional(),
    }),
  },
};
