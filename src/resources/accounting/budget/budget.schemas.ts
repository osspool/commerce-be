/**
 * Budget Route Schemas — Zod v4. Arc auto-converts via `z.toJSONSchema()`
 * at registration (Fastify validation + OpenAPI).
 */
import { z } from 'zod';

// Bulk create — one row per account/period. `amount` is in paisa
// (BDT * 100), label/category are optional metadata.
const bulkItem = z.object({
  account: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  amount: z.number().int(),
  label: z.string().optional(),
  category: z.string().optional(),
});

export const bulkCreateSchema = {
  body: z.object({
    items: z.array(bulkItem).min(1),
  }),
};

export const rejectActionSchema = z.object({ reason: z.string().optional() });
