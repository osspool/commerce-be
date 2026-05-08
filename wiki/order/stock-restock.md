# Refund → goods come back

When goods already shipped, refund must reverse stock and post a COGS-reversal JE.

```
order:refunded   (emitted by full refund: cancel post-fulfilment, RMA covers full order, admin button)
  ├── stockReturnHandler            lifecycle/handlers/stock-return.ts
  │     ├─ guard: fromStatus ∈ {fulfilled, completed}  (pre-shipment refunds skip — already released)
  │     ├─ guard: skip channels where goods don't physically come back (e.g. dine-in POS)
  │     ├─ disposition routing:
  │     │     reason mentions defect/damage → CUSTOMER → ADJUSTMENT (write-off)
  │     │     otherwise                     → CUSTOMER → DEFAULT   (restockable)
  │     └─ flow.services.moveGroup.create({ groupType: 'return' }) → confirm → receive
  │
  └── ledgerRestockBridgeHandler    lifecycle/handlers/ledger-restock-bridge.ts
        → publish accounting:return.restocked
            → handlers/return-restocked.handler  (accounting/events)
                → posting/contracts: DR Inventory / CR COGS  (mirror of cogs.contract)
```

Pre-shipment refunds (cancel before fulfilment) reach a different path: stock is just **released** (reservation drop) by `order-placement.releaseOrderStock` from inside the action handler — no Flow `return` group needed because nothing left the warehouse.

## Files

| File | Role |
|---|---|
| [lifecycle/handlers/stock-return.ts](../../src/resources/sales/orders/lifecycle/handlers/stock-return.ts) | Flow side of refunded post-shipment. |
| [lifecycle/handlers/ledger-restock-bridge.ts](../../src/resources/sales/orders/lifecycle/handlers/ledger-restock-bridge.ts) | Publishes `accounting:return.restocked`. |
| [lifecycle/handlers/_shared.ts](../../src/resources/sales/orders/lifecycle/handlers/_shared.ts) | `pickStockLines`, `isWriteOffDisposition`. |
| [resources/inventory/flow/context-helpers.ts](../../src/resources/inventory/flow/context-helpers.ts) | CUSTOMER / ADJUSTMENT / DEFAULT location ids. |

See also: [fulfillment-ship](fulfillment-ship.md) (the inverse), [refund-admin](refund-admin.md).
