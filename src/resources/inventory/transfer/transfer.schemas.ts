/**
 * Transfer Route Schemas — Zod v4. Arc auto-converts via `z.toJSONSchema()`
 * at registration (Fastify validation + OpenAPI). No manual JSON Schema.
 *
 * Shape enforced at the gateway; `transfer.service` still normalizes
 * (senderBranchId default, productName/variant lookup, totals).
 */
import { z } from 'zod';

const documentType = z.enum(['delivery_note', 'dispatch_note', 'delivery_slip']);

const transferItem = z
  .object({
    productId: z.string(),
    productName: z.string().optional(),
    variantSku: z.string().nullable().optional(),
    quantity: z.number().min(0),
    cartonNumber: z.string().optional(),
    costPrice: z.number().min(0).optional(),
    /**
     * Per-line transit / landed cost in major BDT (decimal). Capitalized
     * into receiver inventory at receive time and credited to the
     * `2126 Transfer Cost Clearing` account by the accounting bridge.
     * See `@classytic/commerce-sdk` `TransferItemPayload`.
     */
    transitCost: z.number().min(0).optional(),
    notes: z.string().optional(),
    sourceLocationId: z.string().optional(),
    destinationLocationId: z.string().optional(),
  })
  .strict();

const receivedItem = z
  .object({
    itemId: z.string().optional(),
    productId: z.string().optional(),
    variantSku: z.string().nullable().optional(),
    quantityReceived: z.number().int().min(0).optional(),
    destinationLocationId: z.string().optional(),
  })
  .strict();

const transport = z
  .object({
    vehicleNumber: z.string().optional(),
    driverName: z.string().optional(),
    driverPhone: z.string().optional(),
    estimatedArrival: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const createSchema = {
  body: z
    .object({
      senderBranchId: z.string().optional(),
      receiverBranchId: z.string(),
      documentType: documentType.optional(),
      remarks: z.string().optional(),
      items: z.array(transferItem).min(1),
    })
    .strict(),
};

export const updateSchema = {
  body: z
    .object({
      remarks: z.string().optional(),
      documentType: documentType.optional(),
      items: z.array(transferItem).optional(),
    })
    .strict(),
};

// Action schemas — all fields optional. Omitting `transport` = simple
// point-to-point dispatch; omitting `items` on receive = receive everything
// in the dispatch; omitting `reason` on cancel = no reason recorded.
export const dispatchActionSchema = z.object({ transport: transport.optional() });
export const receiveActionSchema = z.object({ items: z.array(receivedItem).optional() });
export const cancelActionSchema = z.object({ reason: z.string().optional() });
