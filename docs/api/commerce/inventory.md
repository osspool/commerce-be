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

**Smart transaction creation (ensures no cashflow events are missed):**
- If `supplierName` or `supplierInvoice` provided → auto-creates expense transaction
- If no supplier info → no transaction (manufacturing/homemade products)
- User can explicitly override with `createTransaction: true/false`

Manufacturing/homemade products typically have no supplier info, so they won't create transactions (cost is for profit calculation only, not actual expense).

**Request body (supplier purchase - auto-creates transaction):**
```json
{
  "items": [
    {
      "productId": "product_id",
      "variantSku": "SKU-RED-M",
      "quantity": 10,
      "costPrice": 250
    }
  ],
  "branchId": "head_office_branch_id",
  "purchaseOrderNumber": "PO-2025-001",
  "supplierName": "ABC Supplier",
  "supplierInvoice": "INV-12345",
  "notes": "Monthly stock replenishment",
  "transactionData": {
    "paymentMethod": "bank_transfer",
    "reference": "TRX123456",
    "accountNumber": "1234567890",
    "walletNumber": "01712345678"
  }
}
```

**Request body (manufacturing/homemade - no transaction):**
```json
{
  "items": [
    {
      "productId": "product_id",
      "variantSku": "SKU-RED-M",
      "quantity": 10,
      "costPrice": 150
    }
  ],
  "notes": "Homemade batch - cost for profit calculation only"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | Yes | Items to add to stock |
| `items[].productId` | string | Yes | Product ID |
| `items[].variantSku` | string | No | Variant SKU (null for simple products) |
| `items[].quantity` | integer | Yes | Quantity to add (0 allowed for cost-only correction) |
| `items[].costPrice` | number | No | Cost price per unit (updates weighted average) |
| `branchId` | string | No | Head office branch ID (defaults to configured head office) |
| `purchaseOrderNumber` | string | No | Purchase order reference |
| `supplierName` | string | No | Supplier name |
| `supplierInvoice` | string | No | Supplier invoice number |
| `notes` | string | No | Additional notes |
| `createTransaction` | boolean | No | Override auto-detection (default: true if supplier info provided) |
| `transactionData` | object | No | Transaction details (used when transaction is created) |
| `transactionData.paymentMethod` | string | No | `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card` |
| `transactionData.reference` | string | No | Payment reference (e.g., bank transfer ID) |
| `transactionData.accountNumber` | string | No | Bank account number (for bank transfers) |
| `transactionData.walletNumber` | string | No | Mobile wallet number (for MFS payments) |

**Response (201 or 207):**
```json
{
  "success": true,
  "branch": { "_id": "branch_id", "code": "HO", "name": "Head Office" },
  "items": [
    {
      "productId": "product_id",
      "variantSku": "SKU-RED-M",
      "quantity": 10,
      "costPrice": 250,
      "newTotalQuantity": 50
    }
  ],
  "summary": {
    "totalItems": 1,
    "totalQuantity": 10,
    "errors": 0
  },
  "errors": [],
  "transaction": {
    "_id": "txn_id",
    "amount": 250000
  },
  "message": "1 items added to stock"
}
```

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
| GET | `/api/v1/inventory/transfers` | List transfers (see query params below) |
| GET | `/api/v1/inventory/transfers/:id` | Get transfer by ID or challan number |
| PATCH | `/api/v1/inventory/transfers/:id` | Update draft transfer |
| POST | `/api/v1/inventory/transfers/:id/action` | State transitions (see below) |
| GET | `/api/v1/inventory/transfers/stats` | Transfer statistics (counts by status, pending actions) |

**List Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `senderBranch` | string | Filter by sender branch ID |
| `receiverBranch` | string | Filter by receiver branch ID |
| `status` | string | Filter by status (`draft`, `approved`, `dispatched`, `in_transit`, `received`, `cancelled`) |
| `challanNumber` | string | Search by challan number |
| `documentType` | string | Filter by document type (`delivery_challan`, `dispatch_note`, `delivery_slip`) |
| `startDate` | ISO date | Filter by date range start |
| `endDate` | ISO date | Filter by date range end |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20, max: 100) |
| `sort` | string | Sort field (default: `-createdAt`) |

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
| GET | `/api/v1/inventory/requests` | List requests (see query params below) |
| GET | `/api/v1/inventory/requests/:id` | Request details |
| POST | `/api/v1/inventory/requests/:id/action` | State transitions (see below) |

**List Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `requestingBranch` | string | Filter by requesting branch ID |
| `fulfillingBranch` | string | Filter by fulfilling branch ID |
| `status` | string | Filter by status (`pending`, `approved`, `rejected`, `fulfilled`, `cancelled`) |
| `priority` | string | Filter by priority (`low`, `normal`, `high`, `urgent`) |
| `requestNumber` | string | Search by request number |
| `startDate` | ISO date | Filter by date range start |
| `endDate` | ISO date | Filter by date range end |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20, max: 100) |
| `sort` | string | Sort field (default: `-createdAt`) |

**Request Number Format:** `REQ-YYYYMM-NNNN`

Example: `REQ-202512-0042` (42nd request of December 2025)

**Action endpoint:** `POST /api/v1/inventory/requests/:id/action`
```json
// Approve with optional quantity overrides
{
  "action": "approve",
  "items": [
    { "productId": "...", "variantSku": "SKU-RED-M", "quantityApproved": 8 }
  ],
  "reviewNotes": "Approved partial quantity due to low stock"
}

// Reject request
{ "action": "reject", "reason": "Out of stock at head office" }

// Fulfill approved request → creates Transfer (challan)
{
  "action": "fulfill",
  "documentType": "delivery_challan",
  "remarks": "Urgent shipment"
}

// Cancel request
{ "action": "cancel", "reason": "No longer needed" }
```

**Create Request Body:**
```json
{
  "requestingBranchId": "sub_branch_id",
  "items": [
    {
      "productId": "product_id",
      "variantSku": "SKU-RED-M",
      "quantity": 10,
      "notes": "Running low"
    }
  ],
  "priority": "high",
  "reason": "Festival season demand",
  "expectedDate": "2025-12-25",
  "notes": "Please prioritize"
}
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

**Low-stock response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "stockentry_id",
      "product": {
        "_id": "product_id",
        "name": "Cotton T-Shirt",
        "slug": "cotton-tshirt"
      },
      "variantSku": "TSHIRT-M-RED",
      "quantity": 3,
      "reorderPoint": 10,
      "needsReorder": true
    }
  ]
}
```

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

**Single item adjustment:**
```json
{
  "productId": "product_id",
  "variantSku": "SKU-RED-M",
  "quantity": 5,
  "mode": "remove",
  "reason": "damaged",
  "branchId": "branch_id",
  "lostAmount": 2500,
  "transactionData": {
    "paymentMethod": "cash",
    "reference": "ADJ-2025-001"
  }
}
```

**Bulk adjustment:**
```json
{
  "adjustments": [
    { "productId": "...", "variantSku": "SKU-RED-M", "quantity": 5, "mode": "remove", "reason": "damaged" },
    { "productId": "...", "variantSku": null, "quantity": 3, "mode": "remove", "reason": "expired" }
  ],
  "branchId": "branch_id",
  "lostAmount": 4500,
  "transactionData": {
    "paymentMethod": "cash"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `productId` | string | Yes* | Product ID (for single item) |
| `variantSku` | string | No | Variant SKU (null for simple products) |
| `quantity` | number | Yes | Target quantity or adjustment amount |
| `mode` | string | No | `set` (default), `add`, or `remove` |
| `reason` | string | No | Reason: `damaged`, `lost`, `recount`, `correction` |
| `adjustments` | array | Yes* | Bulk adjustments (alternative to single item) |
| `branchId` | string | No | Branch ID (defaults to main branch) |
| `lostAmount` | number | No | Create expense transaction for this BDT amount |
| `transactionData` | object | No | Transaction details (only used if lostAmount provided) |
| `transactionData.paymentMethod` | string | No | `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer` |
| `transactionData.reference` | string | No | Reference ID |

> *Either `productId` + `quantity` OR `adjustments` array is required.

**Response (single item):**
```json
{
  "success": true,
  "data": {
    "productId": "product_id",
    "variantSku": "SKU-RED-M",
    "newQuantity": 45
  },
  "message": "Stock updated",
  "transaction": {
    "_id": "txn_id",
    "amount": 250000,
    "category": "inventory_loss"
  }
}
```

**Response (bulk):**
```json
{
  "success": true,
  "data": {
    "processed": 5,
    "failed": 1,
    "results": {
      "success": [...],
      "failed": [{ "productId": "...", "error": "Product not found" }]
    }
  },
  "message": "Processed 5, failed 1",
  "transaction": { "_id": "txn_id", "amount": 450000, "category": "inventory_loss" }
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
