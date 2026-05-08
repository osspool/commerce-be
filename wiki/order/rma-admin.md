# Admin RMA confirm / decline

Admin confirms a customer (or self-created) OrderChange → money + stock + ledger move.

```
POST /order-changes/:n/action {action:confirm}   order-change.resource.ts
  → orderChange.confirm()
      → kernel transitions OrderChange: draft → confirmed
      → kernel emits order:change.confirmed { changeNumber }
          → changeConfirmedRefundHandler   lifecycle/handlers/change-confirmed-refund.ts
                ├─ load OrderChange + parent Order
                ├─ guard: changeType ∈ {return, exchange, claim}, not yet processed
                ├─ guard: paymentDelta.refundAmount > 0 (else: store-credit / gift-back, no money)
                ├─ guard: gateway !== cod (else: ops settles manually)
                ├─ executeRefund(...)          services/refund.service.ts
                │   └── revenue.transaction.refund(captureTxn, refundAmount)
                │       → accounting:transaction.refunded → SALES reversal JE
                │   └── order.updatePaymentState({ totalRefunded ↑, transactionRefs ⊕ })
                │   └── stamp order.metadata.refunded*
                ├─ stamp change.metadata.refundProcessedAt (idempotency)
                └─ if cumulative totalRefunded ≥ grandTotal:
                      → order.transition('refunded')
                          → emits order:refunded
                              → stockReturnHandler (reverse Flow shipment)
                              → ledgerRestockBridgeHandler (return JE)

POST /order-changes/:n/action {action:decline, reason}
  → orderChange.decline(reason)
      → kernel transitions: draft → declined
      → kernel writes admin's reason to `internalNote` + `metadata.declineReason`
        (NOT to `.reason` — that field stays the customer's original rationale,
         preserved for the audit trail of *what was asked*.)
      → emits order:change.declined  (no money, no stock — just an audit row)
```

**Decline reason field separation** (kernel rule, both surfaces honor it):

| Field | Holds | Set by |
|---|---|---|
| `change.reason` | Customer's RMA rationale ("size too small", "arrived damaged") | `requestReturn / requestExchange / requestClaim` at creation. **Never overwritten on decline.** |
| `change.internalNote` | Admin's decline rationale | `decline()` |
| `change.metadata.declineReason` | Mirror of `internalNote` for cheap list-view access | `decline()` |

## Per-line dispositions (2026-04-30)

Admin-supplied at change-creation time, drives stock + ledger handlers at confirm:

```
POST /orders/:n/changes  body:
  { changeType: 'return',
    lines: [
      { orderLineId, quantity: 1, disposition: 'restock' },
      { orderLineId, quantity: 1, disposition: 'damaged' },
    ] }
```

| Disposition | Stock destination | Ledger JE class |
|---|---|---|
| `restock` (default) | DEFAULT location (sellable) | `accounting:return.restocked` → COGS reversal (Dr Inventory / Cr COGS) |
| `damaged` / `defective` / `scrap` / `write_off` | ADJUSTMENT location | `accounting:inventory.adjusted` (type=loss) → stock-loss (Dr Shrinkage / Cr Inventory) |

Resolution priority in handlers:
1. `metadata.dispositions[i]` — array aligned with `actions[]`
2. `metadata.disposition` — change-level fallback (applied uniformly)
3. Reason-regex on `change.reason` — legacy fallback (`/defect|damag|brok|write.?off/i` → write-off)

Why split this way: COGS reversal implies the inventory came back as a sellable asset; an inventory-loss JE recognizes that goods left the warehouse permanently (just not in a sale). Posting reversal for damaged items would falsely inflate inventory on the balance sheet and understate cost of running the return process.

## Three-handler decoupling on `order:change.confirmed` (2026-04-30)

Goods, ledger, money — three concerns, three subscribers, all on the same event. Each runs independently of the others.

| Handler | Concern | Independent of |
|---|---|---|
| [change-confirmed-stock-return.ts](../../src/resources/sales/orders/lifecycle/handlers/change-confirmed-stock-return.ts) | Physical goods (Flow moveGroup). Per-action destination per disposition. | Payment gateway, refund amount, payment state. |
| [change-confirmed-ledger-restock-bridge.ts](../../src/resources/sales/orders/lifecycle/handlers/change-confirmed-ledger-restock-bridge.ts) | Per-line COGS reversal OR inventory-loss JE based on disposition. Composite `returnId = ${orderId}:${changeNumber}` so multiple RMAs on one order each get their own JE. | Payment gateway, refund amount. |
| [change-confirmed-refund.ts](../../src/resources/sales/orders/lifecycle/handlers/change-confirmed-refund.ts) | Money settlement (gateway refund). Skips for COD (ops settle manually). | Stock, ledger. |

Legacy handlers `stockReturnHandler` + `ledgerRestockBridgeHandler` remain wired on `order:refunded` (cancel-after-shipped path) but skip when reason matches `Full refund via {return\|exchange\|claim}` — RMA path always wins when both could fire.

## Files

| File | Role |
|---|---|
| [order-change.resource.ts](../../src/resources/sales/orders/order-change.resource.ts) | Admin endpoints `/order-changes`. Auto-CRUD + actions (confirm/decline) + `for-order/:n` queries. |
| [order.resource.ts](../../src/resources/sales/orders/order.resource.ts) | Hosts `POST /orders/:id/changes` admin convenience endpoint (mirrors `/orders/my/:id/changes` without ownership gate). |
| [handlers/my-order-rma.handler.ts](../../src/resources/sales/orders/handlers/my-order-rma.handler.ts) | Customer + admin `requestChange` wrappers. Admin handler stamps `metadata.dispositions[]` + `metadata.disposition`. |
| [lifecycle/handlers/change-confirmed-refund.ts](../../src/resources/sales/orders/lifecycle/handlers/change-confirmed-refund.ts) | Money side. Idempotent via `change.metadata.refundProcessedAt`. |
| [services/refund.service.ts](../../src/resources/sales/orders/services/refund.service.ts) | Shared executor. |

FE admin surfaces:
- per-order: order-sheet "Returns" tab — [`fe-bigboss/commerce/orders/forms/tabs/OrderRmaTab.jsx`](../../../fe-bigboss/commerce/orders/forms/tabs/OrderRmaTab.jsx)
- cross-order queue: `/dashboard/returns` — [`fe-bigboss/commerce/orders/dashboard/returns/returns-client.tsx`](../../../fe-bigboss/commerce/orders/dashboard/returns/returns-client.tsx)

## Backlog (out of scope until forced)

These are well-scoped follow-ups, listed so the design intent is preserved:

1. **Restocking fee booking.** OrderChange schema already carries `paymentDelta.restockingFee`; the kernel's `requestChange` doesn't accept it on input and no handler posts it. To wire: (a) admin endpoint accepts `restockingFee?: number` (paisa), $sets `paymentDelta.restockingFee` post-create; (b) new event + handler `accounting:rma.restocking_fee_collected` → JE Dr Cash/AR / Cr Other Income. Needs a dedicated chart-of-account code in `@classytic/ledger-bd` (`OTHER_INCOME` or `RESTOCKING_FEE`); until then, alias to `revenue` (SALES_REVENUE) is acceptable — Shopify books it that way.

2. **Exchange replacement (auto-create outbound).** When `changeType: 'exchange'` with `internalNote.replacementSku`, no handler currently creates the replacement fulfillment. Real design needs: (a) replacement-stock availability check, (b) price-delta handling (`paymentDelta.chargeAmount` if upgrade, `paymentDelta.refundAmount` if downgrade), (c) new fulfillment on the same order vs new order vs in-place line swap (kernel doesn't yet model line-swap). Defer to a dedicated design pass — not a one-shot PR.

3. **Inspection FSM stage** (Odoo "Quality Check"). Today disposition is set at change-creation time; a quality-controlled workflow would split confirm into `received` (goods arrive at HOLDING location) → `inspect` (per-action disposition decided) → `restocked`/`scrapped`. Adds two FSM states. Worth doing for orgs that need physical inspection separation, overkill for typical retail.

See also: [rma-customer](rma-customer.md), [stock-restock](stock-restock.md), [models](models.md#orderchange).
