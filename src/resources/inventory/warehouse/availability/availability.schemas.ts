/**
 * Stock availability schemas — Zod v4.
 *
 * Mirrors `@classytic/flow`'s AvailabilityCheckResult verbatim — no
 * translation layer, single vocabulary end-to-end.
 */
import { z } from 'zod';

// Arc 2.13: flat wire shape — envelope helper is identity now.
const successEnvelope = (dataSchema: z.ZodTypeAny) => dataSchema;

const availabilityResult = z.object({
  quantityOnHand: z.number(),
  quantityReserved: z.number(),
  quantityAvailable: z.number(),
  quantityIncoming: z.number(),
  quantityOutgoing: z.number(),
});

export const availabilitySchemas = {
  get: {
    querystring: z.object({
      skuRef: z.string().optional().describe('Filter by SKU reference'),
      nodeId: z.string().optional().describe('Filter by warehouse node ID'),
      locationId: z.string().optional().describe('Filter by location ID'),
      branchId: z.string().optional().describe('Organization/branch ID (overrides auth context)'),
    }),
    response: { 200: successEnvelope(availabilityResult) },
  },
  check: {
    body: z.object({
      items: z
        .array(
          z.object({
            skuRef: z.string().describe('SKU reference'),
            quantity: z.number().min(1).describe('Required quantity'),
          }),
        )
        .min(1)
        .describe('Items to check availability for'),
      nodeId: z
        .string()
        .optional()
        .describe('Narrow to a specific warehouse node. Omit to aggregate across the branch.'),
      branchId: z.string().optional().describe('Organization/branch ID'),
    }),
    response: {
      200: successEnvelope(
        z.object({
          allFulfilled: z.boolean(),
          items: z.array(
            z.object({
              skuRef: z.string(),
              requested: z.number(),
              available: z.number(),
              fulfilled: z.boolean(),
            }),
          ),
        }),
      ),
    },
  },
};
