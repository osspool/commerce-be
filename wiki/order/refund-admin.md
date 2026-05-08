# Admin refund (manual button)

`/orders/:id/refund` validates + delegates to the same service the auto handlers use.

```
POST /orders/:id/refund   handlers/refund.handler.ts
  → buildRefundPlan         (validates: not-already-refunded, amount ≤ grand total, …)
  ├─ COD path:
  │   → publish accounting:cod.cancelled  (proportional tax / promo, ledger reverses)
  └─ prepaid path:
      → executeRefund(...)              services/refund.service.ts
          → revenue.transaction.refund(txnId, amount)
              → accounting:transaction.refunded → SALES reversal JE
          → order.updatePaymentState
          → stamp order.metadata.refunded*

  ← if isFullRefund:
      → engine.repositories.order.transition(id, 'refunded')
          → emits order:refunded
              → stockReturnHandler (reverse Flow shipment)
              → ledgerRestockBridgeHandler (return JE)

  ← if body.restockItems && reservation refs exist:
      → flowBridge.releaseStock(refs)   (pre-shipment refund only)
```

The button is the **manual** entry point. The same `executeRefund` is invoked by:
- [cancel](cancel.md) (auto on `order:canceled`)
- [rma-admin](rma-admin.md) (auto on `order:change.confirmed`)

## Files

| File | Role |
|---|---|
| [handlers/refund.handler.ts](../../src/resources/sales/orders/handlers/refund.handler.ts) | Validate + branch (COD vs prepaid) + transition + restock. |
| [services/refund.service.ts](../../src/resources/sales/orders/services/refund.service.ts) | Shared executor. |
| [resolve-capture-txn.ts](../../src/resources/sales/orders/resolve-capture-txn.ts) | Picks the right verified-capture txn id from `paymentState`. |

See also: [stock-restock](stock-restock.md) for the goods side of post-fulfilment refund.
