# Customer-initiated RMA

Self-service return / exchange / claim from `/profile/my-orders`.

```
POST /orders/my/:id/changes      handlers/my-order-rma.handler.ts
  body: { changeType: 'return'|'exchange'|'claim', lines: [{ orderLineId, qty }], reason }

  → auth scope: order owner check (actorRef === userId)
  → engine.repositories.orderChange.{requestReturn|requestExchange|requestClaim}(...)
      → validates: orderLineId exists, qty ≤ fulfilledQty - alreadyReturned (over-return blocked)
      → kernel creates OrderChange in DRAFT
      → kernel emits order:change.requested
      → stamps metadata.initiatedBy = 'customer' (actorKind='user')

GET /orders/my/:id/fulfillments    list shipments + tracking + addresses
GET /orders/my/:id/changes         list this customer's RMA history for the order
```

The OrderChange sits in DRAFT until admin acts on it ([rma-admin](rma-admin.md)). No money moves yet.

## Files

| File | Role |
|---|---|
| [handlers/my-order-rma.handler.ts](../../src/resources/sales/orders/handlers/my-order-rma.handler.ts) | Customer-scoped GET/POST endpoints. |
| [packages/order/src/repositories/order-change.repository.ts](../../../packages/order/src/repositories/order-change.repository.ts) | `requestReturn` / `requestExchange` / `requestClaim` convenience methods + `validateReturnableLines`. |

FE: customer triggers via [`fe-bigboss/app/(home)/profile/my-orders/components/return-request-dialog.jsx`](../../../fe-bigboss/app/(home)/profile/my-orders/components/return-request-dialog.jsx).

See also: [rma-admin](rma-admin.md), [models](models.md#orderchange).
