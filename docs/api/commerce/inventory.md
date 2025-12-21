# Inventory API Guide

Inventory supports a Bangladesh retail flow where **Head Office** owns stock entry (purchases) and controls **inter-branch distribution** using **Transfers**.

## Key Concepts

- **Head Office branch**: the single branch with `role=head_office`.
- **Stock Entry**: per-branch on-hand quantity for a product/variant.
- **Stock Movement**: immutable audit events for every stock change.
- **Transfer**: the document/workflow that moves stock between branches.
- **Cost price (COGS)**: set at Head Office purchases and propagated via transfers; branches do not set cost directly.
- **Source of truth**: StockEntry is the authoritative inventory record; product quantity is derived.

## Base URL

All endpoints are under: `/api/v1/inventory`

## System Architecture: Supply Chain Management

To build a robust retail management system, follow this strict flow of goods:

1.  **Inbound (Head Office):** All new stock enters via **Purchases** at the Warehouse (`role=head_office`). This establishes the "Weighted Average Cost" (COGS).
2.  **Distribution (Challan):** Stock moves to stores via **Transfers**. This maintains the audit trail and ensures stores receive stock at the correct cost price.
3.  **Outbound (POS/Web):** Sales decrement stock at the specific branch.
4.  **Correction (Audit):** Use **Adjustments** only for shrinkage (theft/damage) or cycle count corrections.

**Pro Tip:** Never use "Adjustments" to add new purchased stock at a store. It breaks the detailed cost-tracking chain.

1. **Purchase (Head Office only)** adds stock into head office.
   - If `items[].costPrice` is provided, Head Office `StockEntry.costPrice` is updated using weighted average.
   - Backend also updates a product/variant `costPrice` snapshot for fast reads and fallback.
2. **Transfer** allocates stock from head office to a sub-branch.
3. **Dispatch** decrements head office stock.
4. **Receive** increments sub-branch stock.
   - Receiver branch `StockEntry.costPrice` is updated from the transfer (weighted average if existing stock exists).
5. **Sub-branches** can request stock, receive transfers, and do limited corrections.

## Endpoints (Overview)

> **Pattern Note:** This API follows the **Stripe action-based pattern** for state transitions.
> Instead of multiple endpoints (`/approve`, `/dispatch`, `/receive`), we use a single action endpoint:
> `POST /api/v1/inventory/transfers/:id/action` with `{ action: 'approve' | 'dispatch' | 'in-transit' | 'receive' | 'cancel' }`

### Purchases (Head Office stock entry)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/purchases` | Record purchase (single or batch via `items[]`) |
| GET | `/api/v1/inventory/purchases/history` | Purchase movement history |

**User-controlled transaction creation:**
- `createTransaction: false` (default) → Only creates StockEntry + StockMovement
- `createTransaction: true` → Also creates expense transaction for accounting

Manufacturing/homemade products typically use `createTransaction: false` since cost price is for profit calculation only.

**Cost-only correction (no stock change):**
- You can send `items[].quantity: 0` with a new `items[].costPrice` to correct cost without changing quantity.
- This updates `StockEntry.costPrice` (weighted average logic) and the product/variant cost snapshot used for fast reads.

**Partial success behavior:**
- If some items fail validation, the API returns **207 Multi-Status** with an `errors[]` list.

**Money units note:**
- API inputs like `items[].costPrice` and summaries are in BDT.
- If a Transaction is created, `transaction.amount` is stored in the smallest unit (paisa) per the Transaction model.

### Transfers (inter-branch movement)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/transfers` | Create transfer (draft) |
| GET | `/api/v1/inventory/transfers` | List transfers (`?status=&senderBranch=&receiverBranch=&challanNumber=&documentType=`) |
| GET | `/api/v1/inventory/transfers/:id` | Get transfer by ID or challan number |
| PATCH | `/api/v1/inventory/transfers/:id` | Update draft transfer |
| POST | `/api/v1/inventory/transfers/:id/action` | State transitions (see below) |
| GET | `/api/v1/inventory/transfers/stats` | Transfer statistics (counts by status, pending actions) |

**Action endpoint:** `POST /api/v1/inventory/transfers/:id/action`
```json
{ "action": "approve" }                    // Validate availability
{ "action": "dispatch", "transport": {...}} // Decrement sender, add transport info
{ "action": "in-transit" }                 // Mark package in transit
{ "action": "receive", "items": [...] }    // Increment receiver (optional partial)
{ "action": "cancel", "reason": "..." }    // Cancel (draft/approved only)
```

**Transfer Status Flow:**
```
draft → approved → dispatched → in_transit → received
                                          ↘ partial_received
         ↓ (cancel)
      cancelled
```

**Transfer Types:**
| Type | Description |
|------|-------------|
| `head_to_sub` | Standard distribution (default) |
| `sub_to_sub` | Lateral transfer between sub-branches (admin only) |
| `sub_to_head` | Return to head office (admin only) |

**Permissions:**
- `head_to_sub` requires warehouse/admin roles (head office staff).
- `sub_to_sub` and `sub_to_head` require admin/superadmin.

### Roles & Branch Access (Summary)

**System roles (inventory-relevant):**
| Role | Typical use |
|------|--------------|
| `warehouse-admin` | Head office inventory leadership (purchases, approve/dispatch) |
| `warehouse-staff` | Head office operations (purchases, dispatch support) |
| `store-manager` | Store receiving + POS + local adjustments |
| `finance-admin` | Financial oversight (cost/profit access) |
| `finance-manager` | Finance reporting |
| `admin`, `superadmin` | Full access |

**Branch access model:**
- Users carry branch assignments in their user profile (`branches[]` / legacy `branch`).
- If `branchId` is omitted, the API defaults to the user’s branch for branch-scoped reads.
- Admin/superadmin can operate across branches.

> For detailed challan fields, status history, and lookup options, see [Challan Reference](inventory/challan.md).

### Stock Requests (sub-branch → head office)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/requests` | Create stock request |
| GET | `/api/v1/inventory/requests` | List requests (`?status=pending` for pending) |
| GET | `/api/v1/inventory/requests/:id` | Request details |
| POST | `/api/v1/inventory/requests/:id/action` | State transitions (see below) |

**Action endpoint:** `POST /api/v1/inventory/requests/:id/action`
```json
{ "action": "approve", "items": [...] }   // Approve with quantities
{ "action": "reject", "reason": "..." }   // Reject request
{ "action": "fulfill" }                   // Create Transfer document from approved request
{ "action": "cancel", "reason": "..." }   // Cancel request
```

**Request Status Flow:**
```
pending → approved → fulfilled
                  ↘ partial_fulfilled
    ↓ (reject/cancel)
  rejected / cancelled
```

**Priority Levels:** `low`, `normal` (default), `high`, `urgent`

### Stock viewing & audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/inventory/low-stock` | Low stock alerts |
| GET | `/api/v1/inventory/movements` | Stock movement audit trail |

**Low-stock query parameters:**
| Param | Description |
|-------|-------------|
| `branchId` | Filter by branch (defaults to user's branch) |
| `threshold` | Custom threshold override (defaults to product's `reorderPoint`) |

**Movements query parameters:**
| Param | Description |
|-------|-------------|
| `productId` | Filter by product |
| `branchId` | Filter by branch |
| `type` | Filter by movement type |
| `startDate` | ISO date range start |
| `endDate` | ISO date range end |
| `page`, `limit` | Pagination (default: page=1, limit=50) |

> For movement types and detailed response format, see [Stock Movements Reference](inventory/stock-movements.md).

### Adjustments (local corrections)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/adjustments` | Manual correction with optional transaction |

**User-controlled transaction creation:**
- `lostAmount` not provided → Only creates StockMovement (audit only)
- `lostAmount: 2500` → Also creates expense transaction for ৳2500 inventory loss

**Money units note:**
- `lostAmount` is provided in BDT.
- If a Transaction is created, `transaction.amount` is stored in the smallest unit (paisa) per the Transaction model.

```json
{
  "productId": "...",
  "variantSku": "SKU-RED-M",
  "quantity": 5,
  "mode": "remove",
  "reason": "damaged",
  "lostAmount": 2500 // Creates an Expense transaction for accounting (Opt-in)
}
```

## Transfer Workflow (Recommended)

### 1) Create transfer (draft)

```http
POST /api/v1/inventory/transfers
```

```json
{
  "receiverBranchId": "SUB_BRANCH_ID",
  "documentType": "delivery_challan",
  "items": [
    { "productId": "PRODUCT_ID", "variantSku": "SKU-RED-M", "quantity": 10 }
  ],
  "remarks": "Weekly replenishment"
}
```

`senderBranchId` is optional; if omitted the server uses the configured `role=head_office` branch.

### 2) Approve transfer

```http
POST /api/v1/inventory/transfers/:id/action
```

```json
{ "action": "approve" }
```

Validates stock availability at the sender branch (no stock movement yet).

### 3) Dispatch transfer (stock moves out)

```http
POST /api/v1/inventory/transfers/:id/action
```

```json
{
  "action": "dispatch",
  "transport": {
    "vehicleNumber": "DHA-1234",
    "driverName": "Rahim",
    "driverPhone": "017XXXXXXXX",
    "estimatedArrival": "2025-12-20T12:00:00.000Z"
  }
}
```

On dispatch:

- stock is **decremented** from sender branch
- `StockMovement` audit records are created and linked to this challan via `reference.model='Challan'` and `reference.id=<transferId>` (records as `type=transfer_out` at dispatch)

### 4) Receive transfer (stock moves in)

```http
POST /api/v1/inventory/transfers/:id/action
```

Optional partial receipt:

```json
{
  "action": "receive",
  "items": [
    { "productId": "PRODUCT_ID", "variantSku": "SKU-RED-M", "quantityReceived": 8 }
  ]
}
```

On receive:

- stock is **incremented** at receiver branch
- `StockMovement` audit records are created and linked to this challan via `reference.model='Challan'` and `reference.id=<transferId>` (records as `type=transfer_in` at receive)

## Adjustment Rules (Important)

Manual adjustments are intended for **corrections** (damage, loss, recount), not for distribution.

Server behavior:

- Adjusting **head office** stock requires `admin`/`superadmin`.
- Non-admin users at **sub-branches** cannot increase stock via adjustments; use a transfer instead.
