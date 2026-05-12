# Feature dependency graph

Which engines a resource folder requires, and what breaks if you gate it.

## Engine init order (register-domain-bootstrap.ts)

```
register-infra-plugins (Mongo, audit, idempotency, SSE)         [always]
  → approvalInit                                                 [always]
  → inventoryInit (Flow engine + all WMS resources)  [inventory|warehouse|pos]
  → cartInit                                                     [always — core]
  → pricelistInit                                                [always — core]
  → accountingInit + invoiceInit                     [accounting — gate together]
  → loyaltyInit                                      [loyalty]
  → promoInit                                        [promotions]
  → logisticsInit                                    [logistics]
  → mediaInit                                        [media]
  → crmInit                                          [crm]
  → streamlineInit (workflow engine / cron replacement)          [always — INFRA, not a feature]
```

`streamlineInit` is infrastructure (durable workflows replacing cron — invoice dunning,
subscription billing sweep). It is NOT in FEATURE_CATALOG. Gate via `STREAMLINE_ENABLED` env if needed.

## Cross-resource runtime dependencies

```
orders ─── hub ────────────────────────────────────────────────
  ├── reads  catalog      product data / CatalogBridge    [core]
  ├── reads  inventory    flow.reserve (OrNull → safe if absent)   [inventory?]
  ├── writes loyalty      point credit on paid            [loyalty? engine-exists check]
  ├── reads  promotions   discount eval on placement      [promotions? engine-exists check]
  ├── events accounting   fulfilled → COGS/revenue JE     [accounting? event-driven]
  └── events logistics    shipment creation               [logistics? on-demand]

accounting
  ├── consumes inventory events (procurement/transfer posting)
  └── consumes orders events (fulfilled → ledger)

inventory
  └── consumes catalog (CatalogBridge: SKU → skuRef resolution)
```

`?` = dependency is soft (engine checked with `OrNull` / exists-guard); disabling that feature
degrades gracefully — orders still land, just no points / no discount / no posting.

## Safe to disable (no cascade)

| Feature     | Notes                                                      |
| ----------- | ---------------------------------------------------------- |
| loyalty     | Orders check `getLoyaltyEngineOrNull()` — no crash         |
| promotions  | Order placement falls back to zero discount                |
| logistics   | Fulfillment skips carrier call; manual shipping still works|
| media       | Products use URL strings instead                           |
| crm         | Event bridges are no-ops when engine absent                |
| analytics   | Dashboard-only resources; no write path dependencies       |
| cms         | Content pages only; zero cross-resource imports            |

## Must gate together

| Pair              | Reason                                              |
| ----------------- | --------------------------------------------------- |
| accounting+invoice| `invoice.workflows` depends on ledger init          |
| inventory+warehouse+pos | All three use Flow engine (`inventoryInit`) |

## Files

| File | Purpose |
|------|---------|
| [register-domain-bootstrap.ts](../../src/core/app/register-domain-bootstrap.ts) | Engine init + feature gating |
| [features.ts](../../src/config/features.ts) | FEATURE_CATALOG + `isFeatureEnabled()` |
| [resource-manifest.ts](../../src/config/resource-manifest.ts) | Feature → resource dir mapping |
