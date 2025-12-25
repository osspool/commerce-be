# Challan (Transfer) Reference

Detailed reference for transfer/challan documents, status history, and lookup options.

## Challan Number Format

Transfers are assigned a unique challan number on creation:

```
CHN-YYYYMM-NNNN
```

Example: `CHN-202512-0042` (42nd challan of December 2025)

## Lookup by Challan Number

The transfer endpoint accepts both ID and challan number:

```http
GET /api/v1/inventory/transfers/CHN-202512-0042
```

The server auto-detects the format and routes appropriately.

## Action Endpoint (Stripe Pattern)

State transitions are handled via a single action endpoint:

```http
POST /api/v1/inventory/transfers/:id/action
```

You can include `Idempotency-Key` to make retries safe:
```http
Idempotency-Key: transfer-receive-2025-001
```

```json
{ "action": "approve" }
{ "action": "dispatch", "transport": { "vehicleNumber": "DHA-1234" } }
{ "action": "in-transit" }
{ "action": "receive", "items": [{ "productId": "...", "quantityReceived": 8 }] }
{ "action": "cancel", "reason": "Incorrect items" }
```

**Receive payload notes:**
- `quantityReceived` is the **delta for this call**, not a cumulative total.
- You may pass `itemId` instead of `productId` for precise matching.

**Action Enum:**
| Value | Description |
|-------|-------------|
| `approve` | Validate availability (no stock movement) |
| `dispatch` | Decrement sender stock |
| `in-transit` | Mark shipment in transit |
| `receive` | Increment receiver stock |
| `cancel` | Cancel (draft/approved only) |

**State rules (strict):**
- `approve`: only `draft`
- `dispatch`: only `approved`
- `in-transit`: only `dispatched`
- `receive`: `dispatched`, `in_transit`, or `partial_received`
- `cancel`: `draft` or `approved`

Invalid transitions return `400` with a clear message.

**Example flow:**
```http
POST /api/v1/inventory/transfers/:id/action
Idempotency-Key: transfer-approve-2025-001
```
```json
{ "action": "approve" }
```

```http
POST /api/v1/inventory/transfers/:id/action
Idempotency-Key: transfer-dispatch-2025-001
```
```json
{ "action": "dispatch", "transport": { "vehicleNumber": "DHA-1234" } }
```

**Action Responses (200):**

Approve:
```json
{
  "success": true,
  "data": {
    "_id": "transfer_id",
    "status": "approved"
  }
}
```

Dispatch:
```json
{
  "success": true,
  "data": {
    "_id": "transfer_id",
    "status": "dispatched",
    "dispatchMovements": ["movement_id_1"]
  }
}
```

Receive:
```json
{
  "success": true,
  "data": {
    "_id": "transfer_id",
    "status": "received",
    "receiveMovements": ["movement_id_2"]
  }
}
```

Cancel:
```json
{
  "success": true,
  "data": {
    "_id": "transfer_id",
    "status": "cancelled"
  }
}
```

## Transfer Document Structure

```json
{
  "_id": "transfer_id",
  "challanNumber": "CHN-202512-0042",
  "transferType": "head_to_sub",
  "status": "dispatched",
  "documentType": "delivery_challan",

  "senderBranch": { "_id": "...", "code": "HO", "name": "Head Office" },
  "receiverBranch": { "_id": "...", "code": "DHK", "name": "Dhaka Store" },

  "items": [
    {
      "_id": "item_id",
      "product": "product_id",
      "productName": "Cotton T-Shirt",
      "productSku": "TSHIRT-001",
      "variantSku": "TSHIRT-M-RED",
      "variantAttributes": { "size": "M", "color": "Red" },
      "cartonNumber": "C-12",
      "quantity": 10,
      "quantityReceived": 0,
      "costPrice": 250,
      "notes": "Handle with care"
    }
  ],

  "totalItems": 1,
  "totalQuantity": 10,
  "totalValue": 2500,

  "transport": {
    "vehicleNumber": "DHA-1234",
    "driverName": "Rahim",
    "driverPhone": "017XXXXXXXX",
    "estimatedArrival": "2025-12-20T12:00:00.000Z"
  },

  "statusHistory": [
    { "status": "draft", "timestamp": "...", "actor": "user_id", "notes": null },
    { "status": "approved", "timestamp": "...", "actor": "user_id", "notes": null },
    { "status": "dispatched", "timestamp": "...", "actor": "user_id", "notes": null }
  ],

  "createdBy": "user_id",
  "approvedBy": "user_id",
  "approvedAt": "2025-12-15T09:00:00.000Z",
  "dispatchedBy": "user_id",
  "dispatchedAt": "2025-12-15T10:30:00.000Z",
  "receivedBy": null,
  "receivedAt": null,

  "dispatchMovements": ["movement_id_1", "movement_id_2"],
  "receiveMovements": [],

  "remarks": "Weekly replenishment",
  "internalNotes": "Priority shipment",
  "createdAt": "2025-12-15T08:00:00.000Z",
  "updatedAt": "2025-12-15T10:30:00.000Z",

  "isComplete": false,
  "canEdit": false,
  "canApprove": false,
  "canDispatch": false,
  "canReceive": true,
  "canCancel": false
}
```

## Create Transfer (Draft)

```http
POST /api/v1/inventory/transfers
```

```json
{
  "receiverBranchId": "SUB_BRANCH_ID",
  "documentType": "delivery_challan",
  "items": [
    { "productId": "PRODUCT_ID", "variantSku": "SKU-RED-M", "cartonNumber": "C-12", "quantity": 10 }
  ],
  "remarks": "Weekly replenishment"
}
```

## List Transfers (MongoKit Pagination)

```http
GET /api/v1/inventory/transfers
```

**Offset pagination response (use `page`):**
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

**Keyset pagination response (use `after`/`cursor`):**
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

## Transfer Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `challanNumber` | string | Unique challan number (CHN-YYYYMM-NNNN) |
| `transferType` | string | `head_to_sub`, `sub_to_sub`, `sub_to_head` |
| `status` | string | Current status (see Status Flow) |
| `documentType` | string | `delivery_challan`, `dispatch_note`, `delivery_slip` |
| `senderBranch` | ObjectId | Sender branch reference |
| `receiverBranch` | ObjectId | Receiver branch reference |
| `items` | array | Transfer line items |
| `totalItems` | number | Count of line items |
| `totalQuantity` | number | Sum of all item quantities |
| `totalValue` | number | Sum of (quantity × costPrice) for all items |
| `transport` | object | Vehicle and driver details |
| `statusHistory` | array | Audit trail of status changes |
| `dispatchMovements` | array | StockMovement IDs for sender decrements |
| `receiveMovements` | array | StockMovement IDs for receiver increments |
| `remarks` | string | Public remarks |
| `internalNotes` | string | Internal notes (not shown to external parties) |

**Item Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `product` | ObjectId | Product reference |
| `productName` | string | Product name (snapshot) |
| `productSku` | string | Product SKU (snapshot) |
| `variantSku` | string | Variant SKU (null for simple products) |
| `variantAttributes` | Map | Variant attributes (e.g., `{ "size": "M", "color": "Red" }`) |
| `cartonNumber` | string | Optional carton number for grouping/printing |
| `quantity` | number | Quantity to transfer |
| `quantityReceived` | number | Quantity actually received (for partial receipt) |
| `costPrice` | number | Cost price per unit |
| `notes` | string | Item-level notes |

**Virtual Fields (computed):**

| Field | Type | Description |
|-------|------|-------------|
| `isComplete` | boolean | True if status is `received` |
| `canEdit` | boolean | True if status is `draft` |
| `canApprove` | boolean | True if status is `draft` |
| `canDispatch` | boolean | True if status is `approved` |
| `canReceive` | boolean | True if status is `dispatched` or `in_transit` |
| `canCancel` | boolean | True if status is `draft` or `approved` |

## Status Flow

```
draft ──→ approved ──→ dispatched ──→ in_transit ──→ received
                                                  ↘ partial_received
  │
  └──→ cancelled (from draft or approved only)
```

| Status | Stock Impact | Description |
|--------|--------------|-------------|
| `draft` | None | Transfer created, editable |
| `approved` | None | Validated, ready for dispatch |
| `dispatched` | Sender decremented | Stock left sender warehouse |
| `in_transit` | None | Package in transit (optional step) |
| `received` | Receiver incremented | Full receipt confirmed |
| `partial_received` | Receiver incremented (partial) | Some items received, discrepancy noted |
| `cancelled` | None (or reversed) | Transfer aborted |

**Status Enum:**
`draft`, `approved`, `dispatched`, `in_transit`, `received`, `partial_received`, `cancelled`

## Transfer Types

| Type | Sender | Receiver | Permission |
|------|--------|----------|------------|
| `head_to_sub` | Head Office | Sub-branch | Standard (default) |
| `sub_to_sub` | Sub-branch | Sub-branch | Admin only |
| `sub_to_head` | Sub-branch | Head Office | Admin only |

Type is auto-determined from sender/receiver branch roles.

**Permission notes:**
- `head_to_sub` is restricted to head office roles (warehouse/admin).
- `sub_to_sub` and `sub_to_head` are restricted to admin/superadmin.

## Document Types

| Value | Description |
|-------|-------------|
| `delivery_challan` | Standard delivery document (default) |
| `dispatch_note` | Dispatch document |
| `delivery_slip` | Delivery slip |

## Cost Price Propagation

1. Sender branch `StockEntry.costPrice` is captured at dispatch
2. On receive, receiver's `StockEntry.costPrice` is updated using weighted average:
   ```
   newCost = (existingQty × existingCost + receivedQty × transferCost) / totalQty
   ```
3. This maintains accurate COGS across the distribution chain

## Status History

Every status change is recorded in `statusHistory[]`:

```json
{
  "status": "dispatched",
  "timestamp": "2025-12-15T10:30:00.000Z",
  "actor": "user_id",
  "notes": "Dispatched via DHA-1234"
}
```

Use this for audit trails and delivery tracking.

## Movement Linking

After dispatch/receive, movement IDs are stored:
- `dispatchMovements[]` - StockMovement IDs for sender decrements
- `receiveMovements[]` - StockMovement IDs for receiver increments

Query these for detailed audit:
```http
GET /api/v1/inventory/movements?type=transfer_out&reference.id=<transferId>
```

## Data Retention

Completed and cancelled transfers are automatically deleted after **2 years** via MongoDB TTL index.

## Related Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/inventory/transfers/stats` | Counts by status, pending actions |
| GET | `/api/v1/inventory/challans/:challanNumber` | Lookup by challan number |
