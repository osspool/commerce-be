# be-prod Architecture Wiki

> Authoritative map of the POS → Inventory → Flow stack. Maintained alongside
> `CLAUDE.md` + `AGENTS.md`. Last audit: 2026-04-21.

This wiki exists because the stack crosses four packages (@classytic/arc,
@classytic/flow, @classytic/catalog, @classytic/order) and many in-app
resources. New contributors need ONE place to see how stock actually flows,
what the canonical read paths are, and which files are shims we tolerate.

---

## 1. Stock data model — source of truth

```
@classytic/flow.StockQuant      ← authoritative
  organizationId: ObjectId       (branchId)
  locationId: string             (slug or ObjectId str)
  skuRef: string                 (product._id OR variant.sku)
  quantityOnHand, quantityReserved, quantityAvailable, unitCost

Product.stockProjection          ← denormalized read cache
  per-variant quantity, refreshed via FlowEvents.MOVE_DONE
```

Product.stockProjection is **read-only cache**, kept in sync by
[inventory.handlers.ts](src/resources/inventory/inventory.handlers.ts)'s
`syncProductQuantityFromQuant` on `MOVE_DONE` events. Never read it for
fresh stock — always go through Flow.

---

## 2. Canonical read path — "products with branch stock"

Used by the admin inventory page (`/dashboard/inventory`) AND the POS catalog.

```
GET /pos/products?branchId=X&category=…&search=…
  └─ inventoryController.getPosProducts           [inventory.controller.ts:139]
       └─ pos.utils.getPosProducts(branchId, …)    [sales/pos/pos.utils.ts:48]
            ├─ catalog.repositories.product.findAll({status:'active', …})
            └─ getCatalogInventoryBridge().enrichWithStock(products, {branchId})
                 └─ inventory.repository.getBatchBranchStock(productIds, branchId, {}, productVariantMap)
                      └─ flow.repositories.quant.findMany({locationId:'stock'}, ctx)
                           └─ db.flow_stockquants.find({ organizationId:ObjectId(branchId), locationId:'stock' })
```

**Key contract points**

| Step | File:Line | Contract |
|---|---|---|
| `locationId` filter | [context-helpers.ts:111](src/resources/inventory/flow/context-helpers.ts#L111) | Hardcoded literal `'stock'`. If bootstrap wrote locations with ObjectId `_id` and quants reference those, reads return empty. |
| `organizationId` cast | [quant.repository.ts:411](../packages/flow/src/repositories/quant.repository.ts) | `toObjectId(ctx.organizationId)`. branchId MUST be a 24-char hex. Slugs/UUIDs fail silently with a caught `ObjectId` error. |
| `skuRef` matching | [inventory.repository.ts:68-107](src/resources/inventory/inventory.repository.ts#L68-L107) | Simple products → `skuRef === String(product._id)`. Variants → `skuRef === variant.sku`. Requires `productVariantMap` for multi-product variant batches. |
| Write-path parity | [flow/catalog-bridge.ts:18-87](src/resources/inventory/flow/catalog-bridge.ts#L18-L87) | Writes keyed on variant.sku OR product._id. `identifiers.custom.sku` is read-resolver-only — never written. |

## 3. POS endpoint map

| Method | Path | Handler | Module | Notes |
|---|---|---|---|---|
| GET | `/pos/products` | [inventory.controller.ts:139](src/resources/inventory/inventory.controller.ts#L139) `getPosProducts` | inventory | URL lives under /pos but logic is pure inventory. Reused by admin dashboard. |
| GET | `/pos/lookup` | [inventory.controller.ts:101](src/resources/inventory/inventory.controller.ts#L101) `lookup` | inventory | Barcode/SKU scanner. LRU-cached. |
| POST | `/pos/orders` | [sales/pos/pos.controller.ts:97](src/resources/sales/pos/pos.controller.ts#L97) `createOrder` | sales/pos | Delegates to @classytic/order. Enforces shift guard. |
| GET | `/pos/orders/:id/receipt` | [sales/pos/pos.controller.ts:236](src/resources/sales/pos/pos.controller.ts#L236) `getReceipt` | sales/pos | — |
| GET | `/pos/shifts/current` | [shift.handlers.ts:332](src/resources/sales/pos/shift.handlers.ts#L332) | sales/pos | Active shift (open/paused/blind_closed). |
| POST | `/pos/shifts/open` | [shift.handlers.ts:338](src/resources/sales/pos/shift.handlers.ts#L338) | sales/pos | 409 if already active. Snapshots policy. |
| CRUD | `/pos/shifts` | Arc adapter | sales/pos | `state`, `openingCashierId`, `businessDate` filter-able. |
| POST | `/pos/shifts/:id/action` | shift.handlers.ts actions | sales/pos | `pause \| resume \| cash-in \| cash-out \| blind-close \| reconcile \| close` |

## 4. Branch-scope resolution — **two patterns, both load-bearing**

| Helper | Where | Priority order | Membership check |
|---|---|---|---|
| `resolveAuthorizedBranchId(req, requestedBranchId?)` | [context-helpers.ts:86](src/resources/inventory/flow/context-helpers.ts#L86) | `scope.organizationId` → `user.organizationId` → `user.orgId` → `x-organization-id` header | No. Throws 403 on explicit-mismatch only. |
| `resolveShiftBranch(req)` | [shift.handlers.ts:97](src/resources/sales/pos/shift.handlers.ts#L97) | `x-organization-id` header → `scope.organizationId` → session org | **Yes** — checks BA `member` collection when header is explicit (platform admins bypass). |

**Rule of thumb:** the shift helper is the bearer-auth-standard "header-first"
pattern. The legacy `resolveAuthorizedBranchId` is session-first and only
consults the header as last-resort fallback. New branch-scoped endpoints
should follow the shift pattern; migrating the legacy helper is a Phase-3 item.

## 5. Dead code register

| File:Line | Item | Status | Action |
|---|---|---|---|
| [pos.utils.ts:117-149](src/resources/sales/pos/pos.utils.ts#L117-L149) | `validateCartStock` | 0 callers | **Remove** |
| [pos.schemas.ts:141-169](src/resources/sales/pos/pos.schemas.ts#L141-L169) | `adjustStockSchema` | 0 callers | **Remove** |
| [shift.repository.ts:28](src/resources/sales/pos/shift.repository.ts#L28) | `getCurrentShift` (alias) | Still wired at [shift.resource.ts:90](src/resources/sales/pos/shift.resource.ts) | Migrate callers → remove |
| SDK `useInventory` | 0 imports in fe-bigboss | Dead | Decide: consume in inventory UI or drop |
| SDK `earningRulesApi` | 0 imports | Feature not deployed | Keep or park |
| SDK `referralsApi` | 0 imports | Feature not deployed | Keep or park |
| SDK `webhookApi.{verifyManualPayment, rejectManualPayment}` | Marked @deprecated | Aliases of canonical methods | Remove on next minor |

## 6. SDK pattern drift

| Issue | Phase | Status |
|---|---|---|
| Explicit `token` param on PosApi (7 methods) + POS/inventory hooks | Phase 1 | **DONE** — auto-injection via `configureAuth`. |
| Explicit `token` + `organizationId` on OrderApi (11 methods) + hooks | Phase 1 | **DONE** — simplified signatures (positional, no auth scaffolding). |
| `branchId` as query-string / body param on POS + availability + adjustment + movement + transfer | Phase 2 | **DONE** — now travels via `x-organization-id` header (arc-next `organizationId` request option). SDK method signatures unchanged, transport is cleaner. |
| Duplicate endpoint aliases (`setStock`, `adjustStock`, `bulkAdjust` → same endpoint) | Phase 3 | Pending — low priority. |
| Explicit `token` remnants in `scan`, `review`, `customer`, `supplier` APIs | Phase 3 | Pending — low priority. |

**Single vocabulary rule now in force:** no translation layers between Flow,
be-prod, and the SDK. When Flow exposes `{ allFulfilled, items[].fulfilled }`,
the backend and SDK expose the same names verbatim. Renames happen at the
source (Flow), never at the HTTP boundary.

**Branch scoping rule now in force:** session-scoped branch flows as
`x-organization-id` header via `configureAuth().getOrgId()`. SDK methods
accept `branchId` only as an optional *override* (admin cross-branch views),
and it still travels as the header — never as a query string or body field.

## 7. Test coverage map — gaps

| Flow | Covered? | Test file |
|---|---|---|
| POS sale → stock decrement via Flow | ✓ | [pos-scenarios.test.ts](tests/integration/pos-scenarios.test.ts) |
| Purchase receive → quant upsert | ✓ (indirectly) | [inventory-stock-e2e.test.ts](tests/integration/inventory-stock-e2e.test.ts) |
| Multi-branch stock isolation | ✓ | [inventory-multibranch-e2e.test.ts](tests/integration/inventory-multibranch-e2e.test.ts) |
| Reservation lifecycle | ✓ | [reservation-lifecycle.test.ts](tests/integration/reservation-lifecycle.test.ts) |
| Shift lifecycle + variance | ✓ | [pos-shift-lifecycle.test.ts](tests/integration/pos-shift-lifecycle.test.ts) |
| **`GET /pos/products` reflects received stock** | **✗** | — (the gap that let the "all out of stock" symptom through) |
| `GET /inventory/availability` direct | ✗ | — |
| `GET /inventory/low-stock` threshold | ✗ | — |
| Stock adjustment → POS cache invalidation | ✗ | — |
| Variant-product enrichment when `productVariantMap` omitted | ✗ | — (silently collapses to 0) |

## 8. "Everything out of stock" diagnostic playbook

When the admin inventory page shows all items as 0, run the queries in
order. Each rules out one class of failure.

```js
const BRANCH = ObjectId("<paste branch _id>");

// (1) Any quants at all?
db.flow_stockquants.countDocuments({ organizationId: BRANCH })

// (2) Correct locationId?
db.flow_stockquants.distinct("locationId", { organizationId: BRANCH })
// Expected: includes "stock". If only ObjectId-looking strings → bootstrap drift.

// (3) skuRef shape
db.flow_stockquants.find({ organizationId: BRANCH, locationId: "stock" },
  { skuRef:1, quantityOnHand:1 }).limit(20)

// (4) Match skuRefs to products
const skus = db.flow_stockquants.distinct("skuRef", { organizationId: BRANCH, locationId:"stock" });
db.products.countDocuments({ _id: { $in: skus.filter(s => /^[0-9a-f]{24}$/.test(s)).map(s => ObjectId(s)) } });
db.products.countDocuments({ "variants.sku": { $in: skus } });

// (5) Moves stuck in non-done state
db.flow_stockmoves.aggregate([
  { $match: { organizationId: BRANCH } },
  { $group: { _id: "$status", n: { $sum: 1 } } }
])
// If 0 'done' and purchases were "received" → procurement wiring broken.

// (6) organizationId type sanity
db.flow_stockquants.aggregate([
  { $group: { _id: { $type: "$organizationId" }, n: { $sum: 1 } } }
])
// Should be only "objectId". Any "string" rows = legacy data.

// (7) Non-Flow legacy stock collections
db.getCollectionNames().filter(n => /stock|invent/i.test(n) && !n.startsWith("flow_"))
```

After the above, check server logs for
`[inventory.repository] getBatchBranchStock failed` — the previously-silent
path now logs loudly.

## 9. Misalignment register (debt log)

| Item | Severity | Disposition |
|---|---|---|
| `inventory.repository.getBatchBranchStock` bypasses `QuantService.assertTenantContext` by calling the repo directly | Low | Intentional — batch optimization. Tenant still enforced by `multiTenantPlugin` on the repo. |
| `/pos/products` URL lies about intent (it's the canonical inventory-read endpoint, not POS-only) | Low | Cosmetic rename only — not worth migration churn now. |
| No `flow.services.batchAvailability` — we roll our own in-process map | Medium | Fine for Bangladesh retail scale (< few K SKUs/branch). Revisit at multi-10K scale. |
| `getBatchBranchStock` without `productVariantMap` silently collapses variants to 0 | Medium | Guarded: now logs a warning when map is missing. |
| Two branch-resolution helpers (`resolveAuthorizedBranchId` vs `resolveShiftBranch`) | Medium | Shift's header-first pattern is correct for bearer auth. Migrate the other helper in Phase 3. |
| SDK `token: ""` workarounds in [inventory/hooks/inventory.ts:135,198](../packages/commerce-bd-sdk/src/inventory/hooks/inventory.ts#L135) | High | Blocker for SDK 1.0. Phase 1 of standardization. |
| ~~`flow.services.allocation.checkAvailability` returns `available: 0` without `nodeId`~~ | **FIXED** | Flow now auto-restricts to `STOCKABLE_LOCATION_TYPES` so vendor/customer double-entry rows don't zero out physical stock. `QuantRepository` now takes the Location model by constructor injection and queries both `_id` and `code` on the lookup (hosts can key quants by either). Regression test in [packages/flow/tests/services/allocation.service.test.ts](../packages/flow/tests/services/allocation.service.test.ts). |

## API naming convention — single vocabulary end-to-end

We DO NOT translate field names between Flow, backend, and SDK. When Flow
returns `{ allFulfilled, items[].fulfilled }`, the backend and SDK expose
exactly that shape. Translation layers drift silently; a single vocabulary
is easier to trace + debug.

If a field name reads awkwardly to UI code, rename it once at the source
(in `@classytic/flow`). Never translate at the HTTP boundary.

## 10. Module boundaries — who owns what

```
@classytic/flow          WMS kernel: Move, MoveGroup, StockQuant,
                          StockLocation, StockNode, ScanResolve.
                          14 models, 10 services, ports for catalog,
                          counter, customs, labour, lot, pack, person.

@classytic/catalog       Product + variant + category + pricing rules.
                          InventoryBridge / PricingBridge / MediaBridge
                          ports — host wires the implementations.

@classytic/order         Order + Fulfillment + OrderChange engine.
                          9-step pipeline (validate → snapshot → totals
                          → reserve → authorize → create → hooks →
                          loyalty → notify).

be-prod inventory/       Wraps Flow with HTTP routes + bridges
                          (catalog-bridge, context-helpers, bootstrap).
                          Thin — most logic lives in Flow.

be-prod sales/pos/       POS UX layer on top of inventory + order.
                          Shift, pos.controller (order delegation),
                          pos.utils (catalog enrichment).
```

Do NOT add business logic to `be-prod/inventory/` if Flow already has the
primitive. Do NOT add a shift-style domain model to a `@classytic/*` package
until a second tenant needs it (per `feedback_no_speculative_complexity`
memory).

---

## Change log

- **2026-04-21** Initial wiki, written from 4-agent audit after "all items
  out of stock" symptom. Silent catch in `inventory.repository.ts` fixed;
  regression tests being added.
