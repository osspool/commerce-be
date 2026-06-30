# Read-projection pattern (event-driven read caches)

The standard for a denormalised read cache that must stay fresh without a cron.
Use the framework — **`defineProjection` in
[shared/projections.ts](../src/shared/projections.ts)** — for any new hot
read-model. Do NOT hand-roll `subscribe` loops; the framework gives every cache
the same reliability profile (filter → boundary-wrapped idempotent recompute →
reconcile). **Reference consumer: `product.stockProjection`** (storefront stock).

```ts
export const myProjection = defineProjection({
  name: 'ar-aging',
  events: ['accounting:order.paid', 'accounting:transaction.refunded'],
  selectKey: (p) => (typeof p.partnerId === 'string' ? p.partnerId : null), // filter
  recompute: async (partnerId, ctx) => { /* rebuild cache for partnerId from source */ },
  reconcile: async () => { /* full rebuild from source — drift backstop */ },
});
// at boot (after all projection modules import): registerProjections(logger)
```

## The recipe

```
1. ONE canonical source         pick a single source of truth for the value.
   (stockProjection = head-office on-hand ONLY — never sub-branch)

2. Subscribe to the events       every event that mutates the source →
   that mutate the source        recompute the cache. (Flow: MOVE_DONE,
                                  RESERVATION_RELEASED/CONSUMED,
                                  ADJUSTMENT_POSTED, PROCUREMENT_RECEIVED)

3. Filter at the subscriber      early-return for irrelevant events so you
                                  don't burn a recompute. (skip sub-branch
                                  orgs — only HO triggers a storefront sync)

4. Recompute from SOURCE,         read the source fresh and overwrite the
   not from a delta              cache. Idempotent → replays + out-of-order
                                  events converge. (getAvailability → upsert)

5. Fire-and-forget               cache failure must NOT break the business op
                                  (wrapWithBoundary; failures logged, swallowed)

6. Reconcile backstop            a script/job rebuilds the cache from source to
                                  heal drift, REUSING the same recompute path.
                                  (test/backfill-stock-projection.mjs)

7. Manual rebuild endpoint        an admin escape hatch for suspected drift.
                                  (POST /products/:id/sync-stock)
```

Steps 4 + 6 are the load-bearing ones: an idempotent recompute-from-source +
a reconcile backstop are what make the cache trustworthy. A delta-based cache
with no reconcile rots silently — that was the original stockProjection bug.

## Reference: stockProjection

```
flow.move.done / reservation.* / adjustment.posted / procurement.received
  → handleFlowQuantChange (filter: skuRef + organizationId present)   inventory.handlers.ts:183
  → syncProductQuantityFromQuant(skuRef, triggeringOrgId)             inventory.handlers.ts:240
      → buildHeadOfficeFlowContext()  (sub-branch events early-return)
      → getAvailability per variant → rebuild product.stockProjection
  reconcile: test/backfill-stock-projection.mjs  ·  manual: POST /products/:id/sync-stock
```

## When to apply (candidate next consumers)

Reach for this ONLY when a read genuinely gets slow — not pre-emptively. Likely
future candidates, each rebuildable from ledger/order events:

| Read model | Source | Rebuild on |
|---|---|---|
| AR / AP aging | open JE items by partner | JE posted / payment / credit-note / settle |
| Sales overview dashboard | order + transaction totals | order.paid / transaction.refunded |

Each is a `defineProjection({...})` — same framework, no new wiring. Build one
only when its read genuinely gets slow.

## Files

| File | Purpose |
|---|---|
| [shared/projections.ts](../src/shared/projections.ts) | the framework: `defineProjection` / `registerProjections` / `reconcileProjection` / `listProjections` |
| [inventory.handlers.ts](../src/resources/inventory/inventory.handlers.ts) | reference consumer: `stockProjection` + `syncProductQuantityFromQuant` (recompute) |
| [flow/context-helpers.ts](../src/resources/inventory/flow/context-helpers.ts) | `buildHeadOfficeFlowContext()` — pins the read to the canonical source |
| tests/unit/projections.test.ts | framework unit tests |
| test/backfill-stock-projection.mjs | stock reconcile backstop (rebuild from source) |
