# Branch API Guide

Branches represent physical locations (head office, stores, warehouses) used by POS and inventory.

## Key Concepts

- Exactly **one** branch can have `role=head_office` (enforced by model hooks).
- The **first** branch created becomes both `isDefault=true` and `role=head_office`.
- `isDefault` is used when `branchId` is omitted from POS/inventory endpoints.
- Exactly **one** branch can have `isDefault=true` (enforced by model hooks).

## Base URL

All endpoints are under: `/api/v1/branches`

## Management Topology

Proper branch configuration is critical for the inventory engine:

1.  **Head Office (Warehouse):**
    *   **Role:** `head_office`
    *   **Function:** Accepts Purchasing, holds Central Stock, distributes to branches.
    *   **Operations:** `InventoryApi.purchase`, `InventoryApi.createTransfer`

2.  **Retail Outlets (Stores):**
    *   **Role:** `sub_branch` (default)
    *   **Function:** Receives transfers, sells to customers via POS.
    *   **Operations:** `PosApi.createOrder`, `InventoryApi.transferAction('receive')`

This separation ensures a clean "Hub and Spoke" distribution model essential for accurate COGS tracking.

> Note: In backend code, `role` is strictly `head_office | sub_branch`. If you need to represent physical branch classification, use the separate `type` field.

### Branch Types

The `type` field describes the physical nature of a branch (independent of inventory role):

| Type | Description |
|------|-------------|
| `store` | Retail store (default) |
| `warehouse` | Storage/distribution center |
| `outlet` | Factory outlet or discount store |
| `franchise` | Franchisee-operated location |

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/branches` | List branches (filterable by `isActive`, `isDefault`, `code`, `name`, etc.) |
| GET | `/api/v1/branches/:id` | Get a branch by ID |
| POST | `/api/v1/branches` | Create a branch (admin only) |
| PATCH | `/api/v1/branches/:id` | Update a branch (admin only) |
| DELETE | `/api/v1/branches/:id` | Delete a branch (admin only) |
| GET | `/api/v1/branches/code/:code` | Get a branch by code |
| GET | `/api/v1/branches/default` | Get default branch (auto-creates if none exists) |
| POST | `/api/v1/branches/:id/set-default` | Set a branch as default (admin only) |

## Auth & Access

- **Store staff** (admin, store-manager): list/get/by-code/default
- **Admin only:** create/update/delete/set-default

## List Branches

```http
GET /api/v1/branches?isActive=true
```

## Get Default Branch

```http
GET /api/v1/branches/default
```

If no branch exists yet, the system auto-creates:

- `code=MAIN`
- `name=Main Store`
- `role=head_office`
- `isDefault=true`
- `type=store`
- `isActive=true`

## Head Office Rules (Inventory)

Inventory is designed for a **head office → sub-branch** distribution flow:

- Only `role=head_office` should receive supplier purchases (`/api/v1/inventory/purchases/*`).
- Stock distribution to branches must be done via transfers (`/api/v1/inventory/transfers/*`).
- Sub-branches can **receive** transfers and create **stock requests**, but should not create stock independently.

## Important Behaviors

### Cascade Delete

**Warning:** Deleting a branch will also delete all associated inventory data:
- All `StockEntry` documents for that branch
- All `StockMovement` audit records for that branch

This action is irreversible. Consider marking branches as `isActive=false` instead of deleting.

### User Synchronization

Branch updates automatically sync to users:
- When a branch's `code`, `name`, or `role` changes, all users assigned to that branch are updated
- The denormalized `branches[]` array on User documents is kept in sync
- When a branch is deleted, it is removed from all users' branch assignments
