# Fulfillment ship → COGS

Fulfillment marked shipped → flow commits stock → ledger posts COGS.

```
POST /fulfillments/:id/action {ship}    fulfillment/handlers/action.handler.ts
  → engine.repositories.fulfillment.transition(id, 'shipped')
      → kernel emits order:fulfillment.transition (toStatus=shipped)
          ├── stockCommitHandler         lifecycle/handlers/stock-commit.ts
          │     → flow.services.moveGroup.confirm + ship
          │       (decrement reserved → ship out from warehouse → customer location)
          └── ledgerCogsBridgeHandler    lifecycle/handlers/ledger-cogs-bridge.ts
                → publish accounting:order.shipped
                    → cogsHandler (accounting/events/handlers/)
                        → posting/contracts/cogs.contract.ts
                            → ledger: DR COGS / CR Inventory at avg cost
```

Marking `delivered` doesn't post a journal — `shipped` is the inventory-out event. The order's `fulfillmentStatus` denormalizes from per-line counters via the kernel's `findOneAndUpdate` aggregation pipeline (see `packages/order/src/repositories/fulfillment.repository.ts`).

Manual handler: same path, FSM is shorter (`pending → out_for_delivery → delivered`). No `shipped` state, so COGS posts on `delivered`.

**Manual action verbs:** the action.handler `statusMap` translates `send_out → out_for_delivery` and `deliver → delivered`. Use `POST /fulfillments/:id/action {action: 'send_out'}` to mark a manual fulfillment out for delivery.

**Coverage commit (line.fulfilledQuantity):** the kernel bumps `Order.lines.$.fulfilledQuantity` exactly once per fulfillment, on the first FSM transition into a coverage state (`shipped` / `dispatched` / `out_for_delivery` / `delivered` / `granted` / `completed`). Idempotent via `Fulfillment.coverageCommittedAt` — a `shipped → delivered` transition does NOT double-credit. Customer RMA validation reads `fulfilledQuantity - returnedQuantity`; this is what makes "Request Return" work post-ship.

## Files

| File | Role |
|---|---|
| [fulfillment/handlers/action.handler.ts](../../src/resources/sales/orders/fulfillment/handlers/action.handler.ts) | Action verb → status mapping → kernel transition. |
| [lifecycle/handlers/stock-commit.ts](../../src/resources/sales/orders/lifecycle/handlers/stock-commit.ts) | Flow side-effect on shipped. |
| [lifecycle/handlers/ledger-cogs-bridge.ts](../../src/resources/sales/orders/lifecycle/handlers/ledger-cogs-bridge.ts) | Publishes `accounting:order.shipped`. |
| [resources/accounting/posting/contracts/cogs.contract.ts](../../src/resources/accounting/posting/contracts/cogs.contract.ts) | Cost-of-goods journal entry shape. |
| [_cost-resolver.ts](../../src/resources/sales/orders/lifecycle/handlers/_cost-resolver.ts) | Picks the right cost basis (avg / FIFO / standard). |

See also: [stock-restock](stock-restock.md) (reverse on refund), [models](models.md#fulfillment).
