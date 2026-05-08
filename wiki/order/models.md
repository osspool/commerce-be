# Order kernel models

Live in `@classytic/order` (read-only from be-prod's perspective). be-prod
wires Arc resources around them.

## Order
Single doc per customer purchase. Holds line snapshots + denormalised
projections (paymentState, fulfillmentSummary, fulfillmentStatus).

- Identity: `orderNumber` (e.g. `ORD-2026-0040`) — Arc `:id` routes resolve **by orderNumber**, not `_id`. Pass orderNumber from the FE.
- Address snapshot: `shippingAddress?` / `billingAddress?` (kernel 0.1.3+). Optional — digital/POS-pickup orders skip.
- FSM: `pending → confirmed → fulfilled → completed | refunded | canceled` (open enum; type handlers register custom states for `auction`, `trade`, etc.)
- Source: [`packages/order/src/domain/entities/order.entity.ts`](../../../packages/order/src/domain/entities/order.entity.ts), [`packages/order/src/models/order.model.ts`](../../../packages/order/src/models/order.model.ts)

## paymentState (subdoc on Order)
Denormalised projection of revenue ledger.
- `chargeStatus: 'none' | 'partial' | 'full' | 'overcharged'` — **no `refunded` value**. Detect fully refunded by `totalRefunded.amount === totalCharged.amount`.
- `totalAuthorized / totalCharged / totalRefunded` (all Money)
- `transactionRefs[]` — capture / refund / authorization audit trail
- Source: [`packages/order/src/domain/value-objects/payment-state.vo.ts`](../../../packages/order/src/domain/value-objects/payment-state.vo.ts)

## Fulfillment
One doc per shipment. Multi-fulfilment splits supported.
- `handlerCode`: `physical` | `manual` | `digital` | `booking` | `service` | `subscription` | `food_delivery` (or custom registered)
- `trackingInfo?` (carrier-managed only); `shippingAddress?` (per-fulfilment override)
- `coverageCommittedAt?: Date` — stamped on first transition into a coverage state (shipped/out_for_delivery/delivered/granted/completed). Guards `Order.lines.$.fulfilledQuantity` from double-credit.
- FSMs: per handler, see [`packages/order/src/domain/state-machines/fulfillment.fsm.ts`](../../../packages/order/src/domain/state-machines/fulfillment.fsm.ts)
- Source: [`packages/order/src/domain/entities/fulfillment.entity.ts`](../../../packages/order/src/domain/entities/fulfillment.entity.ts)

## OrderChange
Medusa-style RMA primitive. Returns / exchanges / claims / edits / cancels.
- FSM: `draft → pending_review → confirmed | declined | canceled`
- `actions[]`: line-level mutations (`return_item`, `add_item`, `remove_item`, `refund`, `charge`, `update_item`)
- `paymentDelta`: `{ netAmount, refundAmount, chargeAmount, restockingFee }` — drives [rma-admin](rma-admin.md)
- `inspectionResult?`, `claimEvidence?`, `returnShipping?`
- `reason`: customer's RMA rationale, set at creation. **Never overwritten by decline** (see [rma-admin](rma-admin.md)).
- `internalNote`: admin's decline rationale. Set by `decline(reason)`. Mirrored to `metadata.declineReason` for list-view access.
- `metadata.initiatedBy`: `'customer' | 'admin' | 'system'` — auto-stamped from `ctx.actorKind`
- `metadata.refundProcessedAt`: stamped by `change-confirmed-refund` lifecycle handler — idempotency guard against event-bus replay
- Source: [`packages/order/src/domain/entities/order-change.entity.ts`](../../../packages/order/src/domain/entities/order-change.entity.ts)

## OrderEvent
Append-only audit timeline. Every FSM transition / domain event lands here.
- Indexed by `orderId + occurredAt`. Used by `/orders/:n/events`.
- Source: [`packages/order/src/domain/entities/order-event.entity.ts`](../../../packages/order/src/domain/entities/order-event.entity.ts)

## Relationships

```
Order ──┬── OrderLine[]      (embedded — capped at 200, immutable post-create)
        ├── shippingAddress / billingAddress  (optional snapshots)
        ├── paymentState (embedded subdoc)
        │     └── transactionRefs[]   ── refer to revenue.Transaction docs
        └── fulfillmentSummary (embedded counters)

Order  1──N  Fulfillment        (orderId)
Order  1──N  OrderChange        (orderId, changeNumber unique)
Order  1──N  OrderEvent         (audit trail)
OrderChange  ─→  triggers refund via lifecycle handler  (see rma-admin.md)
```

## Why no `Return` model?
Retired in favor of `OrderChange`. The legacy `be-prod/src/resources/sales/returns/` directory is gone (deleted 2026-04-29). Single source of truth for RMA = OrderChange. See [rma-admin](rma-admin.md).
