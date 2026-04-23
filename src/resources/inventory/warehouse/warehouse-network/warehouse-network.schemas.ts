/**
 * Warehouse-network config schemas — Zod v4.
 */
import { z } from 'zod';

const warehouseNetworkEntry = z.object({
  destinationNodeId: z.string(),
  resupplyFromNodeIds: z.array(z.string()),
});

export const warehouseNetworkSchemas = {
  get: {
    response: {
      200: z.object({
        success: z.literal(true),
        data: z.object({
          entries: z.array(warehouseNetworkEntry),
        }),
      }),
    },
  },
  resolve: {
    body: z.object({
      destinationNodeId: z.string(),
      skuRef: z.string(),
      suggestedQty: z.number().positive(),
    }),
  },
};
