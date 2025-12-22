# POS API Guide

Point of Sale API for in-store operations.

## Base URL

All endpoints are under: `/api/v1/pos`

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/pos/products` | Browse products with branch stock |
| GET | `/api/v1/pos/lookup` | Barcode/SKU scan |
| POST | `/api/v1/pos/orders` | Create order |
| GET | `/api/v1/pos/orders/:orderId/receipt` | Get receipt |
| POST | `/api/v1/pos/stock/adjust` | Adjust stock |

---

## 1. Browse Products

```http
GET /api/v1/pos/products
```

| Param | Type | Description |
|-------|------|-------------|
| branchId | string | Branch ID (uses default if omitted) |
| category | string | Filter by category |
| search | string | Search name, SKU, or barcode |
| inStockOnly | boolean | Only in-stock products |
| lowStockOnly | boolean | Only low stock products |
| sort | string | Sort: `name`, `-createdAt`, `basePrice` |
| after | string | Pagination cursor |
| limit | number | Items per page (default: 50) |

**Response:**

```json
{
  "success": true,
  "branch": { "_id": "xxx", "code": "DHK", "name": "Dhaka" },
  "summary": {
    "totalItems": 150,
    "totalQuantity": 5000,
    "lowStockCount": 12,
    "outOfStockCount": 5
  },
  "docs": [{
    "_id": "product_id",
    "name": "Cotton T-Shirt",
    "basePrice": 500,
    "costPrice": 250,
    "productType": "variant",
    "variants": [
      { "sku": "TSHIRT-M-RED", "attributes": { "size": "M", "color": "Red" }, "priceModifier": 0 }
    ],
    "branchStock": {
      "quantity": 50,
      "inStock": true,
      "lowStock": false,
      "variants": [
        { "sku": "TSHIRT-M-RED", "attributes": { "size": "M", "color": "Red" }, "quantity": 30 }
      ]
    }
  }],
  "hasMore": true,
  "next": "cursor..."
}
```

**Note:** `costPrice` is role-protected and may be omitted/filtered in responses for non-privileged users.

---

## 2. Barcode Lookup

```http
GET /api/v1/pos/lookup?code=BARCODE123&branchId=xxx
```

**Response:**

```json
{
  "success": true,
  "data": {
    "product": {
      "_id": "xxx",
      "name": "Cotton T-Shirt",
      "basePrice": 500,
      "productType": "variant"
    },
    "variantSku": "TSHIRT-M-RED",
    "matchedVariant": {
      "sku": "TSHIRT-M-RED",
      "attributes": { "size": "M", "color": "Red" },
      "priceModifier": 0
    },
    "quantity": 30,
    "branchId": "xxx"
  }
}
```

**Note:** `costPrice` is role-protected and may be omitted/filtered in responses for non-privileged users.

---

## 3. Create Order

```http
POST /api/v1/pos/orders
```

```json
{
  "items": [
    {
      "productId": "xxx",
      "variantSku": "TSHIRT-M-RED",
      "quantity": 2,
      "price": 500
    }
  ],
  "branchId": "xxx",
  "customer": { "name": "John", "phone": "01712345678" },
  "payment": {
    "method": "bkash",
    "amount": 1000,
    "reference": "TRX123456"
  },
  "discount": 50,
  "deliveryMethod": "pickup",
  "idempotencyKey": "pos_2025_12_16_0001"
}
```

### Request Fields

| Field | Required | Description |
|-------|----------|-------------|
| items | ✓ | Array of { productId, quantity, variantSku? } (`price` is ignored; server computes) |
| items[].variantSku | Conditional | Required for variant products |
| branchId | | Branch ID (default if omitted) |
| branchSlug | | Branch slug (optional; takes priority over `branchId`) |
| payment | | Payment details |
| discount | | Discount amount in BDT |
| deliveryMethod | | `pickup` (default) or `delivery` |
| deliveryAddress | | Required if delivery |
| deliveryPrice | | Delivery charge in BDT (used when `deliveryMethod=delivery`) |
| deliveryAreaId | | Logistics area id (number) for delivery pricing/labels (optional) |
| customer | | { name?, phone?, id? } |
| terminalId | | Optional POS terminal identifier (used for idempotency key generation) |
| idempotencyKey | | Prevents duplicate orders on retry |
| notes | | Order notes |

**Delivery address fields (when `deliveryMethod=delivery`):**
- `deliveryAddress.recipientName` **required**
- `deliveryAddress.recipientPhone` **required**, format: `01XXXXXXXXX` (Bangladesh 11-digit)
- `deliveryAddress.addressLine1`, `city`, etc.

### Payment Object

| Field | Type | Description |
|-------|------|-------------|
| method | string | `cash`, `bkash`, `nagad`, `card` |
| amount | number | Payment amount (defaults to order total) |
| reference | string | Transaction ID (for MFS/card payments) |

### Idempotency

- If `idempotencyKey` is omitted, the server generates one: `pos_[terminalId]_[userId]_[timestamp]_[hex]`
- Keys expire after **24 hours** and are then treated as new requests
- If duplicate request is detected with same key and payload, returns cached result (HTTP 200)

**Error responses:**
| Code | Error | Description |
|------|-------|-------------|
| 409 | `REQUEST_IN_PROGRESS` | Same key is currently being processed |
| 409 | `DUPLICATE_REQUEST` | Same key but different payload (tampering) |

### Payment Notes

- If `payment` is omitted, the server treats the order as `cash` and sets amount to the order total.
- `currentPayment.amount` in the order response is stored in **paisa** (smallest unit). Convert to BDT for display.

### Stock Validation

Before checkout, the server validates stock availability:
- Respects web order reservations (doesn't oversell)
- Returns `400` with `unavailable[]` array listing shortage details
- If order creation fails after stock decrement, automatic rollback occurs

**Delivery Methods:**
- `pickup`: Inventory decremented immediately, status = `delivered`
- `delivery`: Inventory decremented immediately, status = `processing`

### Create Order Response

**Success Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "order_id",
    "source": "pos",
    "status": "delivered",
    "branch": "branch_id",
    "terminalId": "POS-01",
    "cashier": "user_id",
    "customerName": "John",
    "customerPhone": "01712345678",
    "items": [...],
    "subtotal": 1000,
    "discountAmount": 50,
    "deliveryCharge": 0,
    "totalAmount": 950,
    "vat": { "applicable": true, "amount": 123.91, ... },
    "currentPayment": {
      "amount": 95000,
      "method": "bkash",
      "reference": "TRX123456",
      "status": "verified"
    },
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "message": "Order created successfully"
}
```

**Idempotent Response (200):**
```json
{
  "success": true,
  "data": { /* same order object */ },
  "message": "Order already exists (idempotent)",
  "cached": true
}
```

> **Note:** `currentPayment.amount` is in paisa (smallest unit). Use `amount / 100` for BDT display.

---

## 4. Get Receipt

```http
GET /api/v1/pos/orders/:orderId/receipt
```

**Response:**

```json
{
  "success": true,
  "data": {
    "orderId": "xxx",
    "orderNumber": "A1B2C3D4",
    "date": "2024-01-15T10:30:00Z",
    "status": "delivered",
    "invoiceNumber": null,
    "branch": { "name": "Dhaka Main", "address": {...}, "phone": "01712345678" },
    "cashier": "John",
    "customer": { "name": "Walk-in", "phone": null },
    "items": [
      { "name": "T-Shirt", "variant": "M", "quantity": 2, "unitPrice": 500, "total": 1000, "vatRate": 0, "vatAmount": 0 }
    ],
    "subtotal": 1000,
    "discount": 50,
    "deliveryCharge": 0,
    "total": 950,
    "vat": { "applicable": false },
    "delivery": { "method": "pickup", "address": null },
    "payment": { "method": "bkash", "amount": 950, "reference": "TRX123456" }
  }
}
```

### Receipt with VAT

When VAT is enabled, receipts include:

```json
{
  "invoiceNumber": "INV-DHK-20240115-0001",
  "items": [
    {
      "name": "T-Shirt",
      "quantity": 2,
      "unitPrice": 500,
      "total": 1000,
      "vatRate": 15,
      "vatAmount": 130.43
    }
  ],
  "subtotal": 1000,
  "vat": {
    "applicable": true,
    "rate": 15,
    "amount": 130.43,
    "taxableAmount": 869.57,
    "sellerBin": "1234567890123",
    "pricesIncludeVat": true
  },
  "total": 1000
}
```

---

## Performance + UI Guidance (Recommended)

- **VAT in UI:** Cache platform VAT config (`GET /api/v1/platform/config`) and product/category VAT rates locally so the UI can show VAT per line instantly. Server remains source-of-truth and returns the final VAT breakdown in the order response.
- **Fast checkout preview:** Compute totals client-side for responsiveness, but keep sending only `items`, `discount`, and `delivery` fields. The server recalculates to prevent tampering.
- **Receipt without extra round-trip:** Use the `POST /api/v1/pos/orders` response to print a basic receipt immediately. If you need full branch/cashier metadata or VAT invoice fields, call the receipt endpoint.
- **Discounts:** Support fixed/percentage discounts in UI and pass the total discount in `discount`. Keep a clear audit trail in UI (reason, approvedBy, manager PIN).
- **Mismatch handling:** If client-side totals differ from server response, show the server values and log the difference for audit.

---

## Post-Sale Flows (Recommended)

- **Reprint:** Use `GET /api/v1/pos/orders/:orderId/receipt`. Cache the last receipts list in the terminal for quick access.
- **Refund/Void:** Keep a cashier/manager permission gate and require a reason. Store linkage to the original order and reference transaction ID in the UI workflow.
- **Hold/Resume:** Persist draft carts locally with a short TTL and a customer identifier (name/phone). On resume, revalidate stock and prices.
- **Last Receipts:** Maintain a local list of last N orders (from responses) so reprint is instant even if the network is slow.

---

## Hardware Flow (Recommended)

- **Barcode scan focus:** Keep input focus on scan field at all times; auto-append quantity when the same SKU is scanned repeatedly.
- **Cash drawer kick:** Trigger the drawer on cash tenders or when the receipt prints; provide a manual override button for supervisors.
- **Thermal printer sizing:** Use 58mm/80mm templates; keep columns aligned and clip long names with ellipses to avoid wrapping during high-volume sales.

---

## Reliability (Recommended)

- **Offline queue:** If the network drops, queue orders locally and retry with the same `idempotencyKey` to prevent duplicates.
- **Retry policy:** Backoff retries (e.g., 1s, 3s, 7s) and surface a "pending" state in the UI until the server confirms.
- **Idempotency:** Generate keys per terminal + cashier + timestamp. Do not reuse keys for different carts.

---

## 5. Adjust Stock

```http
POST /api/v1/pos/stock/adjust
```

This endpoint is intended for **corrections** (damage/loss/recount) and is an alias of `POST /api/v1/inventory/adjustments`.

Important rules (server enforced):

- Head office stock adjustments require `admin`/`superadmin`
- Sub-branches cannot increase stock via adjustments; use transfers instead

**Optional transaction recording (same as Inventory Adjustments):**
- Provide `lostAmount` (BDT) to create an expense transaction (inventory loss/adjustment)
- Omit `lostAmount` to only create StockMovement audit trail

**Single item:**
```json
{
  "productId": "xxx",
  "variantSku": "TSHIRT-M",
  "quantity": 100,
  "mode": "set",
  "branchId": "xxx",
  "reason": "Restock"
}
```

**Bulk:**
```json
{
  "adjustments": [
    { "productId": "xxx", "quantity": 100, "mode": "set" },
    { "productId": "yyy", "quantity": 10, "mode": "remove" }
  ],
  "branchId": "xxx",
  "reason": "Inventory count"
}
```

**With expense transaction (for inventory loss):**
```json
{
  "productId": "xxx",
  "quantity": 5,
  "mode": "remove",
  "branchId": "xxx",
  "reason": "Damaged items",
  "lostAmount": 2500,
  "transactionData": {
    "paymentMethod": "cash",
    "reference": "LOSS-2024-001"
  }
}
```

### Stock Adjust Request Fields

| Field | Type | Description |
|-------|------|-------------|
| productId | string | Product ID (for single adjustment) |
| variantSku | string | Variant SKU (optional) |
| quantity | number | New quantity (for `set`) or delta (for `add`/`remove`) |
| mode | string | `set` (default), `add`, or `remove` |
| adjustments | array | Bulk adjustments (alternative to single fields) |
| branchId | string | Branch ID (uses default if omitted) |
| reason | string | Reason for adjustment |
| lostAmount | number | Optional: amount in BDT to record as expense transaction |
| transactionData | object | Optional: payment details for expense transaction |

### transactionData Object

| Field | Type | Description |
|-------|------|-------------|
| paymentMethod | string | Payment method (cash, bkash, nagad, bank, etc.) |
| reference | string | Transaction reference ID |
| walletNumber | string | Mobile wallet number (for MFS payments) |
| walletType | string | Wallet type (personal/merchant) |
| bankName | string | Bank name (for bank transfers) |
| accountNumber | string | Bank account number |
| accountName | string | Account holder name |
| proofUrl | string | URL to payment proof document |

### Stock Adjust Response

**Single item:**
```json
{
  "success": true,
  "data": {
    "productId": "xxx",
    "variantSku": "TSHIRT-M",
    "newQuantity": 95
  },
  "message": "Stock updated",
  "transaction": {
    "_id": "txn_id",
    "amount": 250000,
    "category": "inventory_loss"
  }
}
```

**Bulk:**
```json
{
  "success": true,
  "data": {
    "processed": 5,
    "failed": 1,
    "results": {
      "success": [
        { "productId": "xxx", "variantSku": null, "newQuantity": 100 },
        { "productId": "yyy", "variantSku": "SKU-M", "newQuantity": 45 }
      ],
      "failed": [
        { "productId": "zzz", "quantity": 10, "error": "Product not found" }
      ]
    }
  },
  "message": "Processed 5, failed 1",
  "transaction": {
    "_id": "txn_id",
    "amount": 500000,
    "category": "inventory_loss"
  }
}
```

> **Note:** `transaction` is only included when `lostAmount` is provided. Amount is in paisa.

---

## Authentication

POS endpoints require a **store staff** role (POS access).
`POST /api/v1/pos/stock/adjust` additionally requires inventory adjustment permission and follows branch role restrictions (head office vs sub-branch).

```
Authorization: Bearer <token>
```

---

## Related APIs

For a complete POS frontend implementation, you may also need:

- **Branches**: `GET /api/v1/branches`, `GET /api/v1/branches/default` — see [Branch API](branch.md)
- **Platform Config**: `GET /api/v1/platform/config` — see [Platform API](../platform.md)
