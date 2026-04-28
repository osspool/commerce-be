/**
 * Accounting event definitions — host-internal events emitted by be-prod
 * itself (order/fulfillment/COD handlers) that the posting subscribers
 * consume.
 *
 * Publishing these as `EventDefinitionOutput<T>` lets us:
 *   1. Register them in `eventRegistry` alongside the 8 package events,
 *      so `eventPlugin({ validateMode: 'reject' })` rejects malformed
 *      `publish('accounting:order.paid', badPayload)` calls in dev/test.
 *   2. Pass the definition (not a string) to `wrapWithSchema` /
 *      `definePostingHandler` so handlers receive `event.payload: T`
 *      with no cast at the call site.
 *   3. Get `PayloadOf<typeof OrderPaidEvent>` for free anywhere we need
 *      the payload type (other subscribers, tests, fixtures).
 *
 * Each Zod schema is the source of truth — `z.toJSONSchema()` derives
 * the JSON schema Arc's registry expects, while `wrapWithSchema`'s
 * `validate` callback re-uses the Zod schema for full nested validation
 * (Arc's built-in JSON validator only covers top-level types).
 */

import { defineEvent, type EventDefinitionOutput, type EventSchema } from '@classytic/arc/events';
import { z } from 'zod';

// ─── Helper: turn a Zod schema into the JSON shape Arc expects ──────────

function toJsonSchema<T extends z.ZodType>(schema: T): EventSchema {
  // `z.toJSONSchema` returns a draft-2020 JSON Schema; Arc's `EventSchema`
  // is a subset that covers `type`, `properties`, `required`. The cast is
  // safe — runtime shape matches what `validatePayload` reads.
  return z.toJSONSchema(schema) as unknown as EventSchema;
}

// ─── Schemas (single source of truth) ───────────────────────────────────

export const orderPaidSchema = z.object({
  transactionId: z.string(),
});

export const transactionRefundedSchema = z.object({
  transactionId: z.string(),
  refundAmount: z.number().optional(),
});

/** One row in the per-line cost provenance — same shape as
 *  `lifecycle/handlers/_cost-resolver.ts::AffectedLine`. */
const affectedLineSchema = z.object({
  lineId: z.string().optional(),
  sku: z.string().optional(),
  productId: z.string().optional(),
  quantity: z.number(),
  source: z.enum(['snapshot', 'product', 'missing']),
});

export const orderFulfilledSchema = z.object({
  orderId: z.string(),
  /** Resolved cost basis (paisa). Bridge stamps this so the handler stays a
   *  pure poster. May be 0 when no cost data was found — entry still posts
   *  with `costMissing: true` for the audit trail. */
  costAmount: z.number().optional(),
  /** Branch the order belongs to. Bridge resolves from the order doc. */
  branchId: z.string().optional(),
  /** True iff at least one line had no resolvable cost (snapshot AND product). */
  costMissing: z.boolean().optional(),
  /** Per-line provenance for the admin "missing cost" view. */
  affectedLines: z.array(affectedLineSchema).optional(),
});

export const cogsCostMissingSchema = z.object({
  orderId: z.string(),
  branchId: z.string().optional(),
  /** Origin of the cost gap — `ship` (COGS post) or `refund` (COGS reversal). */
  trigger: z.enum(['ship', 'refund']),
  affectedLines: z.array(affectedLineSchema),
  date: z.string().optional(),
});

export const returnRestockedSchema = z.object({
  returnId: z.string(),
  orderId: z.string(),
  costAmount: z.number(),
  branchId: z.string(),
  date: z.string().optional(),
  description: z.string().optional(),
  /** Same semantics as `orderFulfilledSchema.costMissing` — the restock
   *  posted with no cost basis, audit-flag the entry. */
  costMissing: z.boolean().optional(),
  affectedLines: z.array(affectedLineSchema).optional(),
});

export const inventoryAdjustedSchema = z.object({
  adjustmentId: z.string(),
  type: z.enum(['loss', 'gain', 'correction']),
  amount: z.number(),
  date: z.string().optional(),
  reason: z.string().optional(),
  branchId: z.string().optional(),
});

export const purchasePaidSchema = z.object({
  purchaseId: z.string(),
  amount: z.number(),
  method: z.string().optional(),
  isPaid: z.boolean().optional(),
  inventoryType: z.string().optional(),
  tax: z.number().optional(),
  vatRate: z.number().optional(),
  branchId: z.string().optional(),
  currency: z.string().optional(),
  exchangeRate: z.number().optional(),
  foreignTotal: z.number().optional(),
});

export const purchaseReceivedSchema = z.object({
  purchaseId: z.string(),
  organizationId: z.string().optional(),
});

export const codSettledSchema = z.object({
  settlementId: z.string(),
  orderId: z.string(),
  grossAmount: z.number(),
  actualReceived: z.number(),
  courierCommission: z.number(),
  writeoff: z.number(),
  cashAccount: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  branchId: z.string(),
});

export const codCancelledSchema = z.object({
  orderId: z.string(),
  grossAmount: z.number(),
  tax: z.number(),
  promoDiscount: z.number().optional(),
  reason: z.string().optional(),
  date: z.string().optional(),
  branchId: z.string(),
});

// ─── EventDefinitionOutput<T> — typed handles for wrapWithSchema ────────

export const OrderPaidEvent: EventDefinitionOutput<z.infer<typeof orderPaidSchema>> = defineEvent({
  name: 'accounting:order.paid',
  description: 'Online order payment verified — sales / COD placement entry.',
  schema: toJsonSchema(orderPaidSchema),
});

export const TransactionRefundedEvent: EventDefinitionOutput<z.infer<typeof transactionRefundedSchema>> = defineEvent({
  name: 'accounting:transaction.refunded',
  description: 'Transaction was refunded — reversal entry.',
  schema: toJsonSchema(transactionRefundedSchema),
});

export const OrderFulfilledEvent: EventDefinitionOutput<z.infer<typeof orderFulfilledSchema>> = defineEvent({
  name: 'accounting:order.fulfilled',
  description: 'Order shipped/fulfilled — COGS entry.',
  schema: toJsonSchema(orderFulfilledSchema),
});

export const ReturnRestockedEvent: EventDefinitionOutput<z.infer<typeof returnRestockedSchema>> = defineEvent({
  name: 'accounting:return.restocked',
  description: 'Returned goods went back into stock — COGS reversal entry.',
  schema: toJsonSchema(returnRestockedSchema),
});

export const InventoryAdjustedEvent: EventDefinitionOutput<z.infer<typeof inventoryAdjustedSchema>> = defineEvent({
  name: 'accounting:inventory.adjusted',
  description: 'Stock adjustment posted — inventory entry.',
  schema: toJsonSchema(inventoryAdjustedSchema),
});

export const PurchasePaidEvent: EventDefinitionOutput<z.infer<typeof purchasePaidSchema>> = defineEvent({
  name: 'accounting:purchase.paid',
  description: 'Purchase invoice paid — purchases entry.',
  schema: toJsonSchema(purchasePaidSchema),
});

export const PurchaseReceivedEvent: EventDefinitionOutput<z.infer<typeof purchaseReceivedSchema>> = defineEvent({
  name: 'purchase:received',
  description: 'Goods received against a purchase — vendor bill accrual entry.',
  schema: toJsonSchema(purchaseReceivedSchema),
});

export const CodSettledEvent: EventDefinitionOutput<z.infer<typeof codSettledSchema>> = defineEvent({
  name: 'accounting:cod.settled',
  description: 'COD settlement recorded — A/R cleared, Bank + Commission posted.',
  schema: toJsonSchema(codSettledSchema),
});

export const CodCancelledEvent: EventDefinitionOutput<z.infer<typeof codCancelledSchema>> = defineEvent({
  name: 'accounting:cod.cancelled',
  description: 'COD order cancelled before settlement — A/R reversal entry.',
  schema: toJsonSchema(codCancelledSchema),
});

export const CogsCostMissingEvent: EventDefinitionOutput<z.infer<typeof cogsCostMissingSchema>> = defineEvent({
  name: 'accounting:cogs.cost_missing',
  description:
    'A COGS post or reversal landed but at least one line had no resolvable cost. Admin signal — finance backfills cost on the product, then re-runs the affected entries via the missing-cost view.',
  schema: toJsonSchema(cogsCostMissingSchema),
});

/** Aggregate — for one-call registration into `eventRegistry`. */
export const accountingEventDefinitions: ReadonlyArray<EventDefinitionOutput> = [
  OrderPaidEvent,
  TransactionRefundedEvent,
  OrderFulfilledEvent,
  ReturnRestockedEvent,
  InventoryAdjustedEvent,
  PurchasePaidEvent,
  PurchaseReceivedEvent,
  CodSettledEvent,
  CodCancelledEvent,
  CogsCostMissingEvent,
] as ReadonlyArray<EventDefinitionOutput>;
