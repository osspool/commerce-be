# Warehouse Management (Flow)

Warehouse nodes, locations, stock audits, availability, and reservations powered by `@classytic/flow`.

## Flow Mode

Set via `FLOW_MODE` env. Controls feature depth:

| Mode | Warehouses | Locations | Audits | Routing | Lot Tracking |
|------|-----------|-----------|--------|---------|-------------|
| `simple` | 1 (auto) | Basic | No | No | No |
| `standard` | 1 | Full hierarchy | Cycle/spot/full | No | Yes |
| `enterprise` | Unlimited | Full hierarchy | Cycle/spot/full | Putaway/removal | Yes |

## Warehouse Nodes

Physical facilities (warehouses, stores, fulfillment centers).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/inventory/nodes` | Create node |
| GET | `/inventory/nodes` | List nodes |
| GET | `/inventory/nodes/:id` | Get node |
| PATCH | `/inventory/nodes/:id` | Update node |

**Node types:** `warehouse`, `store`, `fulfillment_center`, `returns_center`

**Plan limits:** Simple/standard = 1 node max. Enterprise = unlimited.

## Locations

Physical positions within a warehouse (zones, aisles, racks, bins).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/inventory/locations` | List (filter: `nodeId`, `type`, `status`, `parentLocationId`) |
| GET | `/inventory/locations/:id` | Get location |
| POST | `/inventory/locations` | Create location |
| POST | `/inventory/locations/bulk` | Bulk create |
| PATCH | `/inventory/locations/:id` | Update location |
| GET | `/inventory/locations/layout` | Layout grouped by zone → aisle (query: `nodeId`) |
| GET | `/inventory/locations/:id/stock` | Aggregated stock at location |

**Coordinates:** `{ zone, aisle, bay, level, bin }` — supports 3D warehouse addressing.

**Location types (stockable):** `internal`, `receiving`, `storage`, `picking`, `packing`, `shipping`, `transit`, `returns`, `quality_hold`, `damaged`, `production`

**Location types (virtual):** `view`, `vendor`, `customer`, `scrap`, `inventory_loss`

Locations support parent-child hierarchy via `parentLocationId`.

## Stock Availability

Real-time stock queries via Flow's StockQuant aggregation.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/inventory/availability` | Single SKU availability |
| POST | `/inventory/availability/check` | Batch check multiple SKUs |

**Query params:** `skuRef`, `branchId`, `locationId`

**Response fields:** `quantityOnHand`, `quantityReserved`, `quantityAvailable`, `quantityIncoming`, `quantityOutgoing`, `breakdowns[]`

## Reservations

Lock stock for orders/carts before fulfillment.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/inventory/reservations` | Create reservation (soft/hard) |
| POST | `/inventory/reservations/:id/release` | Release (unlock stock) |
| POST | `/inventory/reservations/:id/consume` | Consume (partial or full) |

**Reservation types:** `soft` (expires), `hard` (permanent until consumed/released)

**Status flow:** `active → partially_consumed → consumed` or `released` / `expired`

Expired reservations are cleaned up by background cron (every 5 minutes).

## Stock Audits

Physical inventory counting and reconciliation.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/inventory/audits` | Create audit session |
| GET | `/inventory/audits` | List sessions (filter: `status`) |
| GET | `/inventory/audits/:id` | Get session |
| POST | `/inventory/audits/:id/lines` | Submit count lines |
| GET | `/inventory/audits/:id/variance` | Variance report (expected vs counted) |
| POST | `/inventory/audits/:id/action` | `reconcile` (auto-approve threshold) / `post-moves` |

**Count types:** `full`, `cycle`, `spot`

**Status flow:** `draft → in_progress → pending_review → reconciled → done` (or `cancelled`)

**Variance report fields:** `skuRef`, `locationId`, `expected`, `counted`, `variance`, `variancePercent`

## Barcode Scanning

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/inventory/scan/resolve` | GS1-128 barcode + chain resolver |

Resolves barcode → product/variant → location → stock quant in a single call.
