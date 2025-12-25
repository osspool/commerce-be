# Purchases (Supplier Invoices) API

Purchases are the only official way to bring new inventory into the system.
They are **Head Office only** and drive COGS (weighted average cost).

Base path: `/api/v1/inventory/purchases`

## Response Conventions

**Single resource:**
```json
{
  "success": true,
  "data": { "..." : "..." }
}
```

**List (MongoKit pagination):**
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

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/purchases` | Create purchase invoice (draft) |
| GET | `/api/v1/inventory/purchases` | List purchase invoices |
| GET | `/api/v1/inventory/purchases/:id` | Get purchase invoice |
| PATCH | `/api/v1/inventory/purchases/:id` | Update draft purchase |
| POST | `/api/v1/inventory/purchases/:id/action` | State transitions (receive/pay/cancel) |

## Status Enums

**Purchase Status:** `draft`, `approved`, `received`, `cancelled`  
**Payment Status:** `unpaid`, `partial`, `paid`  
**Payment Terms:** `cash`, `credit`

## Create Purchase (Draft)

```http
POST /api/v1/inventory/purchases
```

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

**Optional immediate payment:**
```json
{
  "payment": {
    "amount": 2500,
    "method": "bank_transfer",
    "reference": "TRX123456"
  }
}
```

**Response (201):**
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

## List Purchases (MongoKit)

```http
GET /api/v1/inventory/purchases
```

**Common filters (examples):**
```
?status=received
?paymentStatus=partial
?supplier=supplier_id
?branch=head_office_branch_id
?invoiceNumber=PINV-202512-0001
?purchaseOrderNumber=PO-2025-001
```

**Pagination:** `page` (offset) or `after`/`cursor` (keyset), plus `limit` and `sort`.

## Get Purchase by ID

```http
GET /api/v1/inventory/purchases/:id
```

## Update Draft Purchase

```http
PATCH /api/v1/inventory/purchases/:id
```

Only `draft` purchases can be updated.

## Action Endpoint (Stripe Pattern)

```http
POST /api/v1/inventory/purchases/:id/action
```

**Idempotency (recommended for pay/receive):**
```http
Idempotency-Key: purchase-pay-2025-001
```

**Actions:**
```json
{ "action": "receive" }
{ "action": "pay", "amount": 1000, "method": "cash" }
{ "action": "cancel", "reason": "Supplier cancelled order" }
```

**State rules (strict):**
- `receive`: `draft` or `approved`
- `cancel`: `draft` or `approved`
- `pay`: any status except `cancelled`

Invalid transitions return `400` with a clear message.

**Example flow:**
```http
POST /api/v1/inventory/purchases/:id/action
Idempotency-Key: purchase-receive-2025-001
```
```json
{ "action": "receive" }
```

```http
POST /api/v1/inventory/purchases/:id/action
Idempotency-Key: purchase-pay-2025-002
```
```json
{ "action": "pay", "amount": 1000, "method": "cash" }
```

### Receive

`receive` auto-approves a draft purchase and creates stock movements.

### Pay

```json
{
  "action": "pay",
  "amount": 1000,
  "method": "cash",
  "reference": "TRX123456"
}
```

**Pay response (200):**
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

### Cancel

Cancels a `draft` or `approved` purchase (no stock impact).

## Notes

- Inputs are in BDT. Transaction amounts are stored in the smallest unit (paisa).
- `items[].costPrice` updates Head Office weighted average cost.
- Frontend should not add stock to branches directly; use transfers.
