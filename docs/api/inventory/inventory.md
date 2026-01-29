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

## Related Docs (FE Quick Links)

- [Purchases](purchases.md)
- [Challan (Transfers)](challan.md)
- [Stock Movements](stock-movements.md)
- [Suppliers (Vendor)](vendor.md)

## Response Conventions (Uniform)

### Single Resource
```json
{
  "success": true,
  "data": { "..." : "..." }
}
```

### List Responses (MongoKit Pagination)

**Offset pagination (use `page`):**
```json
{
  "success": true,
  "method": "offset",
  "docs": [],
  "total": 120,
  "pages": 6,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

**Keyset pagination (use `after`/`cursor`):**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [],
  "limit": 20,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0Ijoi..."
}
```

### Error
```json
{
  "success": false,
  "error": "Human readable message"
}
```

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

## Cross-Branch Stock Visibility

Users can view stock levels in branches other than their own using the `branchId` parameter.

### Viewing Stock in Another Branch

**Product lookup with branch:**
```http
GET /api/v1/pos/lookup?code=SKU-123&branchId=BRANCH_ID
```

**Browse products with branch stock:**
```http
GET /api/v1/pos/products?branchId=BRANCH_ID
```

If `branchId` is omitted, the user's default branch is used.

**Response includes branch-specific stock:**
```json
{
  "success": true,
  "branch": { "_id": "branch_id", "code": "DHK", "name": "Dhaka Store" },
  "summary": {
    "totalItems": 150,
    "totalQuantity": 2500,
    "lowStockCount": 12,
    "outOfStockCount": 5
  },
  "docs": [
    {
      "name": "Cotton T-Shirt",
      "sku": "TSHIRT-001",
      "branchStock": {
        "quantity": 45,
        "variants": [
          { "sku": "TSHIRT-M-RED", "quantity": 20 },
          { "sku": "TSHIRT-L-BLUE", "quantity": 25 }
        ],
        "inStock": true,
        "lowStock": false
      }
    }
  ]
}
```

**Permission notes:**
- Users with `inventory.view` can view stock for branches they have access to.
- Admin/superadmin can view stock for any branch.

### Stock Movements Across Branches

View stock movements for any branch (with appropriate permissions):
```http
GET /api/v1/inventory/movements?branchId=BRANCH_ID
```

### Limitations

- Each request returns stock for **one branch at a time**.
- There is no endpoint that aggregates stock across all branches in a single response.
- For multi-branch stock overview, query each branch separately or use the admin dashboard.

## Endpoints (Overview)

> **Pattern Note:** This API follows the **Stripe action-based pattern** for state transitions.
> Instead of multiple endpoints (`/approve`, `/dispatch`, `/receive`), we use a single action endpoint:
> `POST /api/v1/inventory/transfers/:id/action` with `{ action: 'approve' | 'dispatch' | 'in-transit' | 'receive' | 'cancel' }`

> **Idempotency:** For action endpoints, you may send the `Idempotency-Key` header to make retries safe.
> If the same key + payload is retried, the API returns the cached result and does not repeat side-effects.

### Purchases (Supplier invoices)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/purchases` | Create purchase invoice (draft) |
| GET | `/api/v1/inventory/purchases` | List purchase invoices |
| GET | `/api/v1/inventory/purchases/:id` | Get purchase invoice |
| PATCH | `/api/v1/inventory/purchases/:id` | Update draft purchase |
| POST | `/api/v1/inventory/purchases/:id/action` | State transitions (receive/pay/cancel) |

**Full reference:** [Purchases API](purchases.md)

**Action endpoint:** `POST /api/v1/inventory/purchases/:id/action`
```json
{ "action": "receive" }
{ "action": "pay", "amount": 1000, "method": "cash" }
{ "action": "cancel", "reason": "Supplier cancelled order" }
```

**Idempotent action call example:**
```http
POST /api/v1/inventory/purchases/:id/action
Idempotency-Key: purchase-pay-2025-001
```

**Smart receive:** `receive` auto-approves draft purchases before stock entry.

**Payment behavior:**
- `pay` creates an expense transaction linked to the purchase invoice.
- Supports partial payments; `paymentStatus` becomes `partial` until fully paid.

**Pay action request:**
```json
{
  "action": "pay",
  "amount": 1000,
  "method": "cash",
  "reference": "TRX123456"
}
```

**Pay action response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "purchase_id",
    "paymentStatus": "partial",
    "paidAmount": 1000,
    "dueAmount": 1500
  }
}
```

**Create purchase invoice (draft):**
```json
{
  "supplierId": "supplier_id",
  "purchaseOrderNumber": "PO-2025-001",
  "paymentTerms": "credit",
  "creditDays": 15,
  "items": [
    {
      "productId": "product_id",
      "variantSku": "SKU-RED-M",
      "quantity": 10,
      "costPrice": 250
    }
  ],
  "notes": "Monthly stock replenishment",
  "autoApprove": true,
  "autoReceive": false
}
```

**Purchase Status Enum:**
| Value | Description |
|-------|-------------|
| `draft` | Created, editable |
| `approved` | Approved (implicit when receiving) |
| `received` | Stock received at head office |
| `cancelled` | Cancelled before receipt |

**Payment Status Enum:**
| Value | Description |
|-------|-------------|
| `unpaid` | No payments recorded |
| `partial` | Partially paid |
| `paid` | Fully settled |

**Payment Terms Enum:**
| Value | Description |
|-------|-------------|
| `cash` | Immediate payment |
| `credit` | Payable based on credit days |

**Action Enum (`/purchases/:id/action`):**
| Value | Description |
|-------|-------------|
| `receive` | Auto-approve draft and receive stock |
| `pay` | Record payment |
| `cancel` | Cancel draft/approved purchase |

**Optional payment at creation:**
```json
{
  "items": [
    { "productId": "product_id", "quantity": 10, "costPrice": 250 }
  ],
  "payment": {
    "amount": 2500,
    "method": "bank_transfer",
    "reference": "TRX123456",
    "accountNumber": "1234567890",
    "walletNumber": "01712345678"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | Yes | Items to add to purchase |
| `items[].productId` | string | Yes | Product ID |
| `items[].variantSku` | string | No | Variant SKU (null for simple products) |
| `items[].quantity` | number | Yes | Quantity to purchase |
| `items[].costPrice` | number | Yes | Cost price per unit |
| `supplierId` | string | No | Supplier ID (recommended) |
| `branchId` | string | No | Head office branch ID (defaults to head office) |
| `paymentTerms` | string | No | `cash` or `credit` (defaults from supplier) |
| `creditDays` | number | No | Credit days for payable |
| `dueDate` | string | No | Override due date (ISO date) |
| `autoApprove` | boolean | No | Auto-approve after create |
| `autoReceive` | boolean | No | Auto-receive after approve |
| `payment` | object | No | Optional payment to record immediately |

**Response (create):**
```json
{
  "success": true,
  "data": {
    "_id": "purchase_id",
    "invoiceNumber": "PINV-202512-0001",
    "supplier": "supplier_id",
    "branch": "head_office_branch_id",
    "status": "draft",
    "paymentStatus": "unpaid",
    "grandTotal": 2500,
    "paidAmount": 0,
    "dueAmount": 2500,
    "items": [
      {
        "product": "product_id",
        "productName": "Cotton T-Shirt",
        "variantSku": "SKU-RED-M",
        "quantity": 10,
        "costPrice": 250
      }
    ],
    "createdAt": "2025-12-20T10:00:00.000Z"
  }
}
```

**Payment status:**
- `unpaid` → no payments recorded
- `partial` → partial payment recorded
- `paid` → fully settled

**Money units note:**
- API inputs like `costPrice` and totals are in BDT.
- Transaction amounts are stored in the smallest unit (paisa) per the Transaction model.

### Suppliers (Vendors)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/suppliers` | Create supplier |
| GET | `/api/v1/inventory/suppliers` | List suppliers |
| GET | `/api/v1/inventory/suppliers/:id` | Get supplier |
| PATCH | `/api/v1/inventory/suppliers/:id` | Update supplier |
| DELETE | `/api/v1/inventory/suppliers/:id` | Deactivate supplier |

> For full vendor/supplier reference and examples, see [Vendor API](vendor.md).

**Supplier fields (core):**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Supplier name |
| `code` | string | Optional code (auto-generated if omitted) |
| `type` | string | `local`, `import`, `manufacturer`, `wholesaler` |
| `paymentTerms` | string | `cash` or `credit` |
| `creditDays` | number | Credit days (for payables) |
| `creditLimit` | number | Credit limit in BDT |
| `isActive` | boolean | Active/inactive supplier |

**Supplier Type Enum:**
| Value | Description |
|-------|-------------|
| `local` | Local supplier |
| `import` | Import supplier |
| `manufacturer` | Manufacturer |
| `wholesaler` | Wholesaler |

**Create Supplier Example:**
```json
{
  "name": "ABC Supplier",
  "type": "local",
  "paymentTerms": "credit",
  "creditDays": 15,
  "phone": "01712345678",
  "address": "Dhaka"
}
```

**Response (create):**
```json
{
  "success": true,
  "data": {
    "_id": "supplier_id",
    "name": "ABC Supplier",
    "code": "SUP-0001",
    "type": "local",
    "paymentTerms": "credit",
    "creditDays": 15,
    "isActive": true,
    "createdAt": "2025-12-20T10:00:00.000Z"
  }
}
```

### Transfers (inter-branch movement)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/transfers` | Create transfer (draft) |
| GET | `/api/v1/inventory/transfers` | List transfers (see query params below) |
| GET | `/api/v1/inventory/transfers/:id` | Get transfer by ID or challan number |
| PATCH | `/api/v1/inventory/transfers/:id` | Update draft transfer |
| POST | `/api/v1/inventory/transfers/:id/action` | State transitions (see below) |
| GET | `/api/v1/inventory/transfers/stats` | Transfer statistics (counts by status, pending actions) |

**List response:** uses MongoKit pagination (see Response Conventions above).

**List Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `senderBranch` | string | Filter by sender branch ID |
| `receiverBranch` | string | Filter by receiver branch ID |
| `status` | string | Filter by status (`draft`, `approved`, `dispatched`, `in_transit`, `partial_received`, `received`, `cancelled`) |
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

**Idempotent action call example:**
```http
POST /api/v1/inventory/transfers/:id/action
Idempotency-Key: transfer-dispatch-2025-001
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
- Users carry branch assignments in their user profile (`branches[]` / previous `branch`).
- If `branchId` is omitted, the API defaults to the user’s branch for branch-scoped reads.
- Admin/superadmin can operate across branches.

> For detailed challan fields, status history, and lookup options, see [Challan Reference](challan.md).

### Stock Requests (sub-branch → head office)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/requests` | Create stock request |
| GET | `/api/v1/inventory/requests` | List requests (see query params below) |
| GET | `/api/v1/inventory/requests/:id` | Request details |
| POST | `/api/v1/inventory/requests/:id/action` | State transitions (see below) |

**List response:** uses MongoKit pagination (see Response Conventions above).

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
// Head office assigns carton numbers here for label printing
{
  "action": "fulfill",
  "documentType": "delivery_challan",
  "remarks": "Urgent shipment",
  "items": [
    { "productId": "...", "variantSku": "SKU-RED-M", "quantity": 4, "cartonNumber": "C-01" },
    { "productId": "...", "variantSku": "SKU-BLUE-L", "quantity": 6, "cartonNumber": "C-02" }
  ]
}

// Cancel request
{ "action": "cancel", "reason": "No longer needed" }
```

**Idempotent action call example:**
```http
POST /api/v1/inventory/requests/:id/action
Idempotency-Key: stock-request-approve-2025-001
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

**Partial Approval & Fulfillment (Manager Quantity Control):**

Managers can modify quantities at both approval and fulfillment stages:

| Stage | Field | Behavior |
|-------|-------|----------|
| **Approve** | `quantityApproved` | Can be less than `quantityRequested`. Defaults to full requested amount if not specified. |
| **Fulfill** | `quantity` | Can be less than `quantityApproved`. Cannot exceed approved amount. Defaults to approved amount if not specified. |

**Example flow:** Branch A requests 10 units → Head office approves 8 → Head office fulfills 5 (creates challan for 5 units)

**Quantity tracking per item:**
```json
{
  "product": "product_id",
  "quantityRequested": 10,
  "quantityApproved": 8,
  "quantityFulfilled": 5
}
```

**Fulfillment notes:**
- If `items` is omitted on `fulfill`, approved quantities are sent.
- If `items` is provided, any item not listed defaults to `0`.
- `quantityFulfilled` is tracked per item and rolled into `totalQuantityFulfilled`.
- Status becomes `partial_fulfilled` when `totalQuantityFulfilled < totalQuantityApproved`.

**Carton Labeling (for printing):**
- Sub-branches only request quantities—they don't know how head office will pack.
- Head office assigns `cartonNumber` during fulfillment (e.g., `"C-01"`, `"C-02"`).
- The `cartonNumber` flows into the created Transfer for label printing and tracking.
- Each item can have a different carton number for grouping shipments.
- Use consistent carton numbering per challan (e.g., `CHN-202512-0042-C01`).

**Priority Levels:** `low`, `normal` (default), `high`, `urgent`

### Stock audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/inventory/movements` | Stock movement audit trail |

**Movements query parameters:**
| Param | Description |
|-------|-------------|
| `productId` | Filter by product |
| `branchId` | Filter by branch |
| `type` | Filter by movement type |
| `startDate` | ISO date range start |
| `endDate` | ISO date range end |
| `page`, `limit` | Pagination (default: page=1, limit=50) |

> For movement types and detailed response format, see [Stock Movements Reference](stock-movements.md).

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

**Multi-step receiving:** You can call `receive` multiple times for the same challan (e.g. 4 today, 6 tomorrow).  
`quantityReceived` is treated as the **quantity received in this call** (delta), not a cumulative total.

On receive:

- stock is **incremented** at receiver branch
- `StockMovement` audit records are created and linked to this challan via `reference.model='Challan'` and `reference.id=<transferId>` (records as `type=transfer_in` at receive)

## Adjustment Rules (Important)

Manual adjustments are intended for **corrections** (damage, loss, recount), not for distribution.

Server behavior:

- Adjusting **head office** stock requires `admin`/`superadmin`.
- Non-admin users at **sub-branches** cannot increase stock via adjustments; use a transfer instead.
