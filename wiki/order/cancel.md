# Order cancel

Cancel releases stock + (for prepaid) refunds money via the shared service.

```
POST /orders/:id/action {cancel}    handlers/action.handler.ts
  → engine.repositories.order.transition(id, 'canceled')
      → kernel emits order:canceled
          → cancelRefundPrepaidHandler   lifecycle/handlers/cancel-refund-prepaid.ts
                ├─ COD → return (handled below)
                └─ prepaid:
                    → executeRefund(...)         services/refund.service.ts
                        ├── revenue.transaction.refund(txnId, fullAmount)
                        │     → revenue plugin emits accounting:transaction.refunded
                        │         → transactionRefundedHandler posts SALES reversal JE
                        ├── order.updatePaymentState({ totalRefunded, transactionRefs })
                        └── stamp metadata.refundedAt / refundedAmount / refundReason
  ← back in action.handler.ts (sync, after transition):
      → release Flow stock reservations            order-placement.releaseOrderStock
      → COD only: publish accounting:cod.cancelled (ledger reverses A/R accruals)
```

`order:canceled` is FSM-blocked once `fulfillmentStatus` is `partial` or `fulfilled` — at that point use [refund-admin](refund-admin.md) or [rma-customer](rma-customer.md) instead.

## Files

| File | Role |
|---|---|
| [handlers/action.handler.ts](../../src/resources/sales/orders/handlers/action.handler.ts) | FSM verb router; releases reservations + COD-cancel branch. |
| [lifecycle/handlers/cancel-refund-prepaid.ts](../../src/resources/sales/orders/lifecycle/handlers/cancel-refund-prepaid.ts) | Listens to `order:canceled`, delegates to refund service. |
| [services/refund.service.ts](../../src/resources/sales/orders/services/refund.service.ts) | Single source for revenue.refund + paymentState sync + metadata stamp. |
| [resources/accounting/events/handlers/transaction-refunded.handler.ts](../../src/resources/accounting/events/handlers/transaction-refunded.handler.ts) | SALES reversal journal entry. |

See also: [refund-admin](refund-admin.md), [rma-admin](rma-admin.md), [stock-restock](stock-restock.md).
