# Payment confirm

Pending revenue txn → verified → order paymentState updated → ledger entry.

```
POST /webhooks/payments/manual/verify  manual-verification.handler.ts
  → revenue.transaction.verify(txnId)
      → revenue plugin emits accounting:transaction.verified
          → transactionVerifiedHandler  (accounting/events/handlers/)
              → posting/contracts/sale.contract.ts
                  → ledger journal entry: DR Cash / CR Sales (+ tax / shipping)
      → engine.repositories.order.confirmPayment(orderId, txnId)
          → kernel updates Order.paymentState.{chargeStatus=full, totalCharged, transactionRefs}
          → kernel transitions Order.status: pending → confirmed
              → emits order:confirmed
```

Provider webhooks (bKash callback, Stripe webhook) hit `/webhooks/payments/:provider` instead — same downstream path after `transaction.verify()`.

## Files

| File | Role |
|---|---|
| [resources/payments/handlers/manual-verification.handler.ts](../../src/resources/payments/handlers/manual-verification.handler.ts) | Superadmin verifies offline / manual payments. |
| [resources/payments/handlers/provider-webhook.handler.ts](../../src/resources/payments/handlers/provider-webhook.handler.ts) | Auto webhooks. |
| [resources/accounting/events/handlers/transaction-verified.handler.ts](../../src/resources/accounting/events/handlers/transaction-verified.handler.ts) | Posts the SALES journal entry. |
| [resources/accounting/posting/contracts/sale.contract.ts](../../src/resources/accounting/posting/contracts/sale.contract.ts) | Builds DR/CR lines. |

See also: [refund-admin](refund-admin.md) (mirror flow on the way out), [models](models.md#paymentstate).
