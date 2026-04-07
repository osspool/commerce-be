# Inventory API Guide

Stock and supply chain management for a single-tenant, multi-branch retail system.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Head Office** | The branch with `role=head_office`. All purchases enter here. |
| **StockEntry** | Per-branch on-hand quantity for a product/variant. Source of truth. |
| **StockMovement** | Immutable audit event for every stock change. |
| **Transfer (Challan)** | Document that moves stock between branches. |
| **Cost Price (COGS)** | Set at purchase (weighted average), propagated via transfers. |
| **Flow Mode** | `simple` / `standard` / `enterprise` — controls WMS feature depth (env: `FLOW_MODE`). |

## Supply Chain Flow

```
Purchase (Head Office) → Transfer (Challan) → Branch receives → POS/Web sale
                                                              → Adjustment (corrections only)
```

Never use adjustments to add purchased stock. It breaks cost tracking.

## Base URL

`/api/v1/inventory`

## Response Conventions

```jsonc
// Single resource
{ "success": true, "data": { ... } }

// List (MongoKit pagination — offset or keyset)
{ "success": true, "method": "offset", "docs": [], "total": 120, "pages": 6, "page": 1, "limit": 20, "hasNext": true }

// Error
{ "success": false, "error": "Human readable message" }
```

## Endpoints Overview

All state transitions use the **Stripe action pattern**: `POST /:id/action { action: "..." }`.
Use `Idempotency-Key` header for safe retries.

### Purchases (Head Office only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/purchases` | Create invoice (draft) |
| GET | `/purchases` | List invoices |
| GET | `/purchases/:id` | Get invoice |
| PATCH | `/purchases/:id` | Update draft |
| POST | `/purchases/:id/action` | `receive` / `pay` / `cancel` |

**Full reference:** [Purchases](purchases.md)

### Transfers (Challan)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/transfers` | Create draft |
| GET | `/transfers` | List |
| GET | `/transfers/:id` | Get by ID or challan number |
| PATCH | `/transfers/:id` | Update draft |
| POST | `/transfers/:id/action` | `approve` / `dispatch` / `in-transit` / `receive` / `cancel` |
| GET | `/transfers/stats` | Counts by status |

**Full reference:** [Challan](challan.md)

### Stock Requests (sub-branch → head office)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/requests` | Create request |
| GET | `/requests` | List (filter: `requestingBranch`, `status`, `priority`) |
| GET | `/requests/:id` | Get details |
| POST | `/requests/:id/action` | `approve` / `reject` / `fulfill` / `cancel` |

Status flow: `pending → approved → fulfilled` (or `rejected` / `cancelled`)
Priority: `low` / `normal` / `high` / `urgent`

Fulfill creates a Transfer (challan) automatically. Supports partial approval and partial fulfillment.

### Adjustments (corrections only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/adjustments` | Single or bulk adjustment |

Modes: `set` (default), `add`, `remove`. Optional `lostAmount` creates expense transaction.

Head office adjustments require admin. Sub-branch users cannot increase stock via adjustments.

### Suppliers

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/suppliers` | Create |
| GET | `/suppliers` | List |
| GET | `/suppliers/:id` | Get |
| PATCH | `/suppliers/:id` | Update |
| DELETE | `/suppliers/:id` | Deactivate |

**Full reference:** [Vendors](vendor.md)

### Stock Movements (audit trail)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/movements` | Filter by `productId`, `branchId`, `type`, date range |
| GET | `/low-stock` | Low stock report |

**Full reference:** [Stock Movements](stock-movements.md)

### Warehouse Management (Flow)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST/GET | `/nodes` | Warehouse CRUD |
| GET/PATCH | `/nodes/:id` | Get/update warehouse |
| GET/POST | `/locations` | Location CRUD |
| POST | `/locations/bulk` | Bulk create locations |
| GET | `/locations/layout` | Layout grouped by zone/aisle |
| GET | `/locations/:id/stock` | Stock at specific location |
| GET | `/availability` | Stock availability (by `skuRef`, `branchId`, `locationId`) |
| POST | `/availability/check` | Batch availability check |
| POST | `/reservations` | Reserve stock (soft/hard) |
| POST | `/reservations/:id/release` | Release reservation |
| POST | `/reservations/:id/consume` | Consume reservation |
| POST/GET | `/audits` | Audit session CRUD |
| POST | `/audits/:id/lines` | Submit count lines |
| GET | `/audits/:id/variance` | Variance report |
| POST | `/audits/:id/action` | `reconcile` / `post-moves` |
| POST | `/scan/resolve` | Barcode/SKU chain resolver |

**Full reference:** [Warehouse](warehouse.md)

## Roles & Permissions

| Role | Access |
|------|--------|
| `superadmin`, `admin` | Full access |
| `warehouse-admin` | Purchases, approve/dispatch transfers |
| `warehouse-staff` | Purchases, dispatch support |
| `store-manager` | Receive transfers, POS, local adjustments |
| `inventory_staff` | Location/audit operations |
| `finance-admin/manager` | Cost/profit visibility |

## Cross-Branch Visibility

Query any branch's stock with `?branchId=BRANCH_ID` (requires `inventory.view` permission or admin role). Each request returns one branch at a time.
