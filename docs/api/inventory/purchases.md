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

**Payment fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | ✓ | `"pay"` |
| `amount` | number | ✓ | Payment amount in BDT |
| `method` | string | ✓ | `cash`, `bkash`, `nagad`, `bank_transfer`, etc. |
| `reference` | string | | Payment reference (trx ID, cheque no.) |
| `transactionDate` | ISO date | | Historical payment date (defaults to now) |
| `accountNumber` | string | | Bank account number |
| `walletNumber` | string | | MFS wallet number |
| `bankName` | string | | Bank name |
| `proofUrl` | string | | Payment proof URL |
| `notes` | string | | Payment notes |

**Historical payment example (for backdated entries):**
```json
{
  "action": "pay",
  "amount": 5000,
  "method": "bank_transfer",
  "reference": "CHQ-001234",
  "transactionDate": "2025-12-15T10:00:00.000Z",
  "bankName": "Dutch Bangla Bank",
  "notes": "Payment for November invoice"
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

## Tax/VAT Support

Purchases support VAT/tax at the item level, which flows to the payment transaction for finance reporting.

### Purchase Item Tax Fields

| Field | Type | Description |
|-------|------|-------------|
| `taxRate` | number | Tax rate percentage (0-100), e.g., `15` for 15% VAT |
| `taxableAmount` | number | Net amount before tax (calculated by server) |
| `taxAmount` | number | Calculated tax amount for line item |

### Create Purchase with Tax

```json
{
  "supplierId": "supplier_id",
  "purchaseOrderNumber": "PO-2025-001",
  "items": [
    {
      "productId": "product_id",
      "quantity": 10,
      "costPrice": 250,
      "taxRate": 15
    }
  ]
}
```

**Response includes tax breakdown:**
```json
{
  "data": {
    "items": [
      {
        "product": "product_id",
        "quantity": 10,
        "costPrice": 250,
        "taxRate": 15,
        "taxableAmount": 2500,
        "taxAmount": 375,
        "lineTotal": 2875
      }
    ],
    "subTotal": 2500,
    "taxTotal": 375,
    "grandTotal": 2875
  }
}
```

### Tax in Payment Transactions

When a purchase is paid, the tax data flows to the transaction:

**Transaction Tax Fields:**

| Field | Source | Description |
|-------|--------|-------------|
| `tax` | Proportional to payment | Tax in paisa |
| `taxDetails.type` | `'vat'` | Tax type |
| `taxDetails.rate` | Dominant item rate | Rate as decimal (0.15) |
| `taxDetails.isInclusive` | `false` | B2B purchases are tax-exclusive |
| `taxDetails.jurisdiction` | `'BD'` | Bangladesh |

**Partial Payment Tax Calculation:**
```
paymentTax = purchaseTaxTotal × (paymentAmount / grandTotal)
```

**Example Payment Transaction:**
```json
{
  "_id": "txn_id",
  "flow": "outflow",
  "type": "inventory_purchase",
  "amount": 287500,
  "tax": 37500,
  "net": 287500,
  "sourceModel": "Purchase",
  "sourceId": "purchase_id",
  "taxDetails": {
    "type": "vat",
    "rate": 0.15,
    "isInclusive": false,
    "jurisdiction": "BD"
  }
}
```

**See Also:** [Transaction API - Tax/VAT Support](../finance/transaction.md#taxvat-support-in-transactions)

---

## Notes

- Inputs are in BDT. Transaction amounts are stored in the smallest unit (paisa).
- `items[].costPrice` updates Head Office weighted average cost.
- Frontend should not add stock to branches directly; use transfers.
- Tax is calculated per item and summed to `taxTotal` at purchase level.
- Partial payments receive proportional tax allocation.
- **Cashflow model:** Transaction `net` = `amount` (actual money paid). Tax is informational for VAT reporting, not subtracted from net. See [Transaction API - Amount Fields](../finance/transaction.md#accounting-model-cashflow-vs-double-entry).
