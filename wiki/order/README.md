# order wiki

Order lifecycle, RMA, refund, fulfillment in be-prod. All money-movement
flows go through the same `services/refund.service.ts` — single source of truth.

## Pages

| Flow | When | File |
|---|---|---|
| [place](place.md) | customer / POS / admin places an order | `/orders/place`, `/pos/orders` |
| [confirm-payment](confirm-payment.md) | gateway webhook or manual verify lands | `/webhooks/payments/manual/verify` |
| [fulfillment-ship](fulfillment-ship.md) | fulfillment FSM hits `shipped` | `/fulfillments/:id/action {ship}` |
| [cancel](cancel.md) | order canceled (admin or customer) | `/orders/:id/action {cancel}` |
| [refund-admin](refund-admin.md) | admin clicks "refund" | `/orders/:id/refund` |
| [rma-customer](rma-customer.md) | customer requests return / exchange / claim | `/orders/my/:id/changes` |
| [rma-admin](rma-admin.md) | admin confirms / declines a customer RMA | `/order-changes/:id/action` |
| [stock-restock](stock-restock.md) | refunded order's goods come back | event `order:refunded` |
| [models](models.md) | core docs + their relationships | `@classytic/order` models |

## Glossary

- **kernel** = `@classytic/order` package (Order/Fulfillment/OrderChange/OrderEvent).
- **lifecycle handler** = host-side event listener that turns a kernel event into side-effects (revenue, ledger, flow, notifications). Lives in [`src/resources/sales/orders/lifecycle/`](../../src/resources/sales/orders/lifecycle/).
- **bridge** = port-shaped adapter handing one engine's primitives to another. Lives in [`src/resources/sales/orders/bridges/`](../../src/resources/sales/orders/bridges/).
