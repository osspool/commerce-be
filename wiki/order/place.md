# Order placement

Web checkout → reserved stock → order doc → pending payment.

```
POST /orders/place                   handlers/place.handler.ts
  → executePlacement                 placement.service.ts
      → cart price check + stock reservation (Flow)
      → engine.repositories.order.create({ shippingAddress, billingAddress, … })
          → kernel emits order:created
              → order-revenue-hook.ts (after:create on Order repo)
                  → revenue.bridge.ts
                      → revenue.transaction.createPaymentIntent (bkash/card)
                        OR  revenue.transaction.recordImmediatePayment (cash/COD)
              → order-loyalty-hook.ts (member earn rules, deferred)
```

POS variant: `POST /pos/orders` → [`pos/pos.controller.ts`](../../src/resources/sales/pos/pos.controller.ts) → same `executePlacement`, channel pinned to `pos`, payment method pre-selected (immediate VERIFIED txn).

## Files

| File | Role |
|---|---|
| [handlers/place.handler.ts](../../src/resources/sales/orders/handlers/place.handler.ts) | Fastify entry. |
| [placement.service.ts](../../src/resources/sales/orders/placement.service.ts) | Stock reserve → snapshot → kernel create → idempotency-race recovery. Address snapshot lives here (kernel 0.1.3+). |
| [order-payment.ts](../../src/resources/sales/orders/order-payment.ts) | Routes payment method → revenue bridge call. |
| [bridges/revenue.bridge.ts](../../src/resources/sales/orders/bridges/revenue.bridge.ts) | Ports kernel money primitives → revenue API. |
| [order-revenue-hook.ts](../../src/resources/sales/orders/order-revenue-hook.ts) | Subscribes `after:create` on the order repo. |

See also: [confirm-payment](confirm-payment.md), [models](models.md#order).
