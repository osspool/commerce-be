/**
 * Stock Request Route Schemas — Zod v4. Arc auto-converts via
 * `z.toJSONSchema()` at registration (Fastify validation + OpenAPI).
 */
import { z } from 'zod';

const priority = z.enum(['low', 'normal', 'high', 'urgent']);

const requestItem = z
  .object({
    productId: z.string(),
    variantSku: z.string().nullable().optional(),
    quantity: z.number().min(0),
    notes: z.string().optional(),
  })
  .strict();

const fulfillItem = z
  .object({
    itemId: z.string().optional(),
    productId: z.string().optional(),
    variantSku: z.string().nullable().optional(),
    quantity: z.number().int().min(0).optional(),
  })
  .strict();

export const createSchema = {
  body: z
    .object({
      requestingBranchId: z.string().optional(),
      fulfillingBranchId: z.string().optional(),
      priority: priority.optional(),
      reason: z.string().optional(),
      expectedDate: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(requestItem).min(1),
    })
    .strict(),
};

// Action schemas — fulfill items optional (defaults to approved quantities).
// Reason optional on cancel. `submit_for_approval` and `decide` schemas come
// from the shared `withApprovalChain` preset and are not redeclared here.
export const fulfillActionSchema = z.object({
  documentType: z.enum(['delivery_note', 'dispatch_note', 'delivery_slip']).optional(),
  remarks: z.string().optional(),
  items: z.array(fulfillItem).optional(),
});

export const cancelActionSchema = z.object({ reason: z.string().optional() });
