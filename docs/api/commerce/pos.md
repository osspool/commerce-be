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
| category | string | Category slug filter (matches `product.category` or `product.parentCategory`) |
| search | string | Search name, SKU, or barcode |
| inStockOnly | boolean | Only in-stock products |
| lowStockOnly | boolean | Only low stock products |
| sort | string | Sort: `name`, `-createdAt`, `basePrice` |
| after | string | Keyset cursor (MongoKit) |
| limit | number | Items per page (default: 50, max: 100) |

**Response (MongoKit keyset pagination):**

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

## Payment Methods Source (Platform Config)

POS payment options are **not hardcoded**. Load them from platform config and map to POS `payment.method`.

```http
GET /api/v1/platform/config?select=paymentMethods
```

**Mapping rule:**
- `type= mfs` → use `provider` as `payment.method` (`bkash`, `nagad`, `rocket`, `upay`)
- `type= bank_transfer` → `payment.method = "bank_transfer"`
- `type= card` → `payment.method = "card"`
- `type= cash` → `payment.method = "cash"`

Only send methods where `isActive=true`.

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
  "membershipCardId": "MBR-12345678",
  "payment": {
    "method": "bkash",
    "amount": 1000,
    "reference": "TRX123456"
  },
  "payments": [
    { "method": "cash", "amount": 300 },
    { "method": "bkash", "amount": 200, "reference": "TRX-SPLIT-1" }
  ],
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
| membershipCardId | | Membership card ID for customer lookup and points (e.g., `MBR-12345678`) |
| pointsToRedeem | | Points to redeem for discount (requires active membership) |
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
| method | string | `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card` (from platform config) |
| amount | number | Payment amount (defaults to order total) |
| reference | string | Transaction ID (for MFS/card payments) |
| payments | array | Optional split payments array (see below) |

**Split payments (optional):**
- Provide `payments[]` to accept multiple methods for a single order.
- If `payments[]` is present, omit `payment` to avoid ambiguity.
- The sum of `payments[].amount` must equal the order total.

**Split payment entry fields:**
| Field | Type | Description |
|-------|------|-------------|
| method | string | `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card` |
| amount | number | Amount for this method (BDT) |
| reference | string | Transaction ID (optional, for non-cash) |
| details | object | Method-specific fields (walletNumber, bankName, etc.) |

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
- If `payments` is provided, the server stores `currentPayment.method = "split"` and includes the breakdown.
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
    "membershipApplied": {
      "cardId": "MBR-12345678",
      "tier": "Gold",
      "pointsEarned": 15,
      "pointsRedeemed": 0,
      "tierDiscountApplied": 50,
      "tierDiscountPercent": 5
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
    "payment": {
      "method": "bkash",
      "amount": 950,
      "reference": "TRX123456",
      "payments": [
        { "method": "cash", "amount": 300 },
        { "method": "bkash", "amount": 650, "reference": "TRX123456" }
      ]
    },
    "membership": {
      "cardId": "MBR-12345678",
      "tier": "Gold",
      "pointsEarned": 15,
      "tierDiscount": 50
    }
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

- **Membership Discounts (Real-Time):** See [Section 6.11](#611-client-side-discount-calculations-performance-optimization) for complete guide on client-side tier discount and points redemption calculations. Cache platform config once and calculate locally for instant UI updates.
- **VAT in UI:** Cache platform VAT config (`GET /api/v1/platform/config`) and product/category VAT rates locally so the UI can show VAT per line instantly. Server remains source-of-truth and returns the final VAT breakdown in the order response.
- **Fast checkout preview:** Compute totals client-side for responsiveness, but keep sending only `items`, `discount`, `membershipCardId`, `pointsToRedeem`, and `delivery` fields. The server recalculates everything to prevent tampering.
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
| paymentMethod | string | Payment method (`cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`) |
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

## 6. Membership Cards

Membership cards provide loyalty points and tier-based discounts at POS. This section covers the complete in-store experience.

---

### 6.1 In-Store Experience Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        POS MEMBERSHIP FLOW                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. CUSTOMER ARRIVES                                                │
│     └─→ Cashier: "Do you have a membership card?"                   │
│                                                                     │
│  2a. YES - SCAN/ENTER CARD                                          │
│      └─→ Pass membershipCardId in order                             │
│      └─→ Customer auto-resolved (no name/phone needed)              │
│      └─→ Tier discount auto-applied                                 │
│      └─→ Points calculated & shown on receipt                       │
│                                                                     │
│  2b. NO - OFFER ENROLLMENT                                          │
│      └─→ "Would you like to join our loyalty program?"              │
│      └─→ If yes: Create customer → Enroll → Show new card ID        │
│      └─→ Immediately use new card for this order                    │
│                                                                     │
│  2c. NO & DECLINE                                                   │
│      └─→ Walk-in sale (no customer record)                          │
│      └─→ Or create customer without membership                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 Customer Resolution Priority

When creating a POS order, customer is resolved in this order:

| Priority | Field | Behavior |
|----------|-------|----------|
| 1 | `membershipCardId` | Auto-resolve from card. Customer name/phone NOT needed. |
| 2 | `customer.id` | Lookup existing customer by ID |
| 3 | `customer.phone` | Find or create customer by phone |
| 4 | None | Walk-in sale (no customer record) |

**Key Point:** When `membershipCardId` is provided, the `customer` object is completely optional.

---

### 6.3 Enrollment Methods

Membership operations use an action-based API pattern (similar to Stripe):

#### Staff Enrolls Customer (at counter)
```http
POST /api/v1/customers/:id/membership
Authorization: Bearer <staff_token>
Content-Type: application/json

{ "action": "enroll" }
```
- Used when cashier enrolls customer at POS
- Requires `customers.update` permission
- Returns customer with new membership card

#### Customer Self-Enrolls (via app/web)
```http
POST /api/v1/customers/me/membership
Authorization: Bearer <customer_token>
Content-Type: application/json

{ "action": "enroll" }
```
- Customer applies for membership themselves
- Requires authenticated customer
- Auto-creates customer profile if needed

**Response (both methods):**
```json
{
  "success": true,
  "data": {
    "_id": "customer_id",
    "name": "John Doe",
    "phone": "01712345678",
    "membership": {
      "cardId": "MBR-12345678",
      "isActive": true,
      "enrolledAt": "2024-01-15T10:30:00Z",
      "points": { "current": 0, "lifetime": 0, "redeemed": 0 },
      "tier": "Bronze"
    }
  }
}
```

---

### 6.4 POS Order with Membership

**Simplest form (membership card only):**
```json
{
  "items": [{ "productId": "xxx", "quantity": 2 }],
  "branchId": "xxx",
  "membershipCardId": "MBR-12345678",
  "payment": { "method": "cash", "amount": 1000 }
}
```

That's it! No customer name/phone needed. Server auto-resolves everything.

**With points redemption:**
```json
{
  "items": [{ "productId": "xxx", "quantity": 2 }],
  "branchId": "xxx",
  "membershipCardId": "MBR-12345678",
  "pointsToRedeem": 500,
  "payment": { "method": "cash", "amount": 950 }
}
```

Points redemption rules (from Platform Config):
- `redemption.enabled` must be `true`
- `pointsToRedeem` >= `minRedeemPoints` (default: 100)
- Order total >= `minOrderAmount` (default: 0)
- Discount capped at `maxRedeemPercent` of order (default: 50%)
- Conversion: `pointsPerBdt` points = 1 BDT discount (default: 10)

**Response includes:**
```json
{
  "success": true,
  "data": {
    "_id": "order_id",
    "customerName": "John Doe",
    "customerPhone": "01712345678",
    "customer": "customer_id",
    "subtotal": 1000,
    "discountAmount": 97,
    "totalAmount": 903,
    "membershipApplied": {
      "cardId": "MBR-12345678",
      "tier": "Gold",
      "pointsEarned": 14,
      "pointsRedeemed": 500,
      "pointsRedemptionDiscount": 50,
      "tierDiscountApplied": 47,
      "tierDiscountPercent": 5
    }
  }
}
```

---

### 6.5 Membership Config (Platform)

```http
GET /api/v1/platform/config?select=membership
```

```json
{
  "membership": {
    "enabled": true,
    "pointsPerAmount": 1,
    "amountPerPoint": 100,
    "roundingMode": "floor",
    "tiers": [
      { "name": "Bronze", "minPoints": 0, "pointsMultiplier": 1, "discountPercent": 0 },
      { "name": "Silver", "minPoints": 500, "pointsMultiplier": 1.25, "discountPercent": 2 },
      { "name": "Gold", "minPoints": 2000, "pointsMultiplier": 1.5, "discountPercent": 5 },
      { "name": "Platinum", "minPoints": 5000, "pointsMultiplier": 2, "discountPercent": 10 }
    ],
    "cardPrefix": "MBR",
    "cardDigits": 8
  }
}
```

### Points Calculation

```
basePoints = (orderTotal / amountPerPoint) * pointsPerAmount
earnedPoints = floor(basePoints * tierMultiplier)
```

**Example:** Gold member (1.5x), 1000 BDT order:
- Base: (1000 / 100) × 1 = 10 points
- With multiplier: 10 × 1.5 = 15 points

---

### 6.6 Frontend UI Recommendations

#### Membership Input Field
```
┌─────────────────────────────────────────────┐
│  [🔍] Enter or scan membership card         │
│  ┌─────────────────────────────────────┐   │
│  │ MBR-                                │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  [✓ Member found: John Doe - Gold tier]     │
│  [Discount: 5% | Points to earn: 15]        │
└─────────────────────────────────────────────┘
```

#### Enrollment Button (for new customers)
```
┌─────────────────────────────────────────────┐
│  Customer: +01712345678                     │
│  [📇 Enroll in Membership Program]          │
└─────────────────────────────────────────────┘
```

#### Receipt Display
```
──────────────────────────────────────
MEMBERSHIP CARD: MBR-12345678
TIER: Gold (5% discount)
──────────────────────────────────────
Points earned this purchase: +15
Total points: 2,015
Next tier (Platinum): 2,985 points away
──────────────────────────────────────
```

---

### 6.7 Card Lookup Endpoint

To preview membership info before checkout:

```http
GET /api/v1/customers?membership.cardId=MBR-12345678
Authorization: Bearer <token>
```

**Response:**
```json
{
  "docs": [{
    "_id": "customer_id",
    "name": "John Doe",
    "phone": "01712345678",
    "membership": {
      "cardId": "MBR-12345678",
      "isActive": true,
      "tier": "Gold",
      "points": { "current": 2000, "lifetime": 2500 }
    }
  }],
  "totalDocs": 1
}
```

---

### 6.8 Deactivate Membership

```http
POST /api/v1/customers/:id/membership
Authorization: Bearer <staff_token>
Content-Type: application/json

{ "action": "deactivate" }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "membership": {
      "cardId": "MBR-12345678",
      "isActive": false,
      "tier": "Gold",
      "points": { "current": 2000, "lifetime": 2500 }
    }
  },
  "message": "Membership deactivated"
}
```

**Note:** Deactivated cards return `400` error at POS: `"Membership card not found: MBR-12345678"`

---

### 6.9 Best Practices

| Practice | Recommendation |
|----------|----------------|
| **Card scanning** | Keep focus on membership input; support barcode/QR scanning |
| **Preview before checkout** | Show tier, discount %, and points-to-earn before finalizing |
| **Enrollment prompt** | Ask non-members at checkout; highlight benefits |
| **Receipt messaging** | Show points earned, total points, and progress to next tier |
| **Offline handling** | Cache last-used card IDs; retry with same idempotency key |
| **Staff training** | Train on asking "Do you have a membership card?" first |

---

### 6.10 Related Endpoints

All membership operations use an action-based API pattern:

| Endpoint | Body | Description |
|----------|------|-------------|
| `POST /api/v1/customers/:id/membership` | `{ action: 'enroll' }` | Staff enrolls customer |
| `POST /api/v1/customers/:id/membership` | `{ action: 'deactivate' }` | Deactivate card |
| `POST /api/v1/customers/:id/membership` | `{ action: 'reactivate' }` | Reactivate card |
| `POST /api/v1/customers/:id/membership` | `{ action: 'adjust', points, reason }` | Adjust points (admin) |
| `POST /api/v1/customers/me/membership` | `{ action: 'enroll' }` | Customer self-enrolls |
| `GET /api/v1/customers?membership.cardId=X` | - | Lookup by card ID |
| `GET /api/v1/platform/config?select=membership` | - | Get membership config |

---

### 6.11 Client-Side Discount Calculations (Performance Optimization)

For fast, responsive POS UI, implement **client-side discount previews** using cached platform config. Server remains source-of-truth and recalculates everything, but client-side calculations provide instant visual feedback.

#### Why Client-Side Calculations?

**Problem:** Calling server for every cart change creates lag:
- ❌ User scans item → wait 200ms for server → update UI
- ❌ User enters points → wait 200ms for validation → show discount
- ❌ Poor UX during busy hours, network latency

**Solution:** Cache config once, calculate locally:
- ✅ User scans item → instant total update
- ✅ User enters points → instant discount preview
- ✅ Smooth UX, no network dependency for previews
- ✅ Server validates on final checkout (security maintained)

#### Step 1: Cache Platform Config on App Load

Fetch once when POS app starts. Cache for session or until cashier logs out.

```javascript
// On POS app initialization
let membershipConfig = null;

async function initializePOS() {
  try {
    const response = await fetch('/api/v1/platform/config?select=membership');
    const { data } = await response.json();
    membershipConfig = data.membership;

    // Store in memory or localStorage
    localStorage.setItem('membershipConfig', JSON.stringify(membershipConfig));
  } catch (error) {
    console.error('Failed to load membership config:', error);
    // Fallback: POS still works, just no client-side preview
  }
}

// Reload config every 5 minutes (or on manual refresh)
setInterval(initializePOS, 5 * 60 * 1000);
```

**Config Structure:**
```json
{
  "enabled": true,
  "pointsPerAmount": 1,
  "amountPerPoint": 100,
  "roundingMode": "floor",
  "tiers": [
    { "name": "Bronze", "minPoints": 0, "pointsMultiplier": 1, "discountPercent": 0 },
    { "name": "Silver", "minPoints": 500, "pointsMultiplier": 1.25, "discountPercent": 2 },
    { "name": "Gold", "minPoints": 2000, "pointsMultiplier": 1.5, "discountPercent": 5 }
  ],
  "redemption": {
    "enabled": true,
    "minRedeemPoints": 100,
    "minOrderAmount": 0,
    "maxRedeemPercent": 50,
    "pointsPerBdt": 10
  }
}
```

#### Step 2: Implement Calculation Functions

**2.1 Calculate Tier Discount**

```javascript
function calculateTierDiscount(subtotal, tierName) {
  if (!tierName || !membershipConfig?.tiers) return 0;

  const tier = membershipConfig.tiers.find(t => t.name === tierName);
  if (!tier || !tier.discountPercent) return 0;

  return Math.round(subtotal * tier.discountPercent / 100);
}

// Example:
// subtotal = 1000, tier = 'Gold' (5% discount)
// Returns: 50
```

**2.2 Validate Points Redemption**

```javascript
function validateRedemption(pointsToRedeem, customerPoints, orderTotal) {
  const config = membershipConfig.redemption;

  if (!config?.enabled) {
    return { valid: false, error: 'Points redemption not enabled' };
  }

  if (pointsToRedeem < config.minRedeemPoints) {
    return { valid: false, error: `Minimum ${config.minRedeemPoints} points required` };
  }

  if (pointsToRedeem > customerPoints) {
    return { valid: false, error: `Insufficient points. Available: ${customerPoints}` };
  }

  if (orderTotal < config.minOrderAmount) {
    return { valid: false, error: `Minimum order of ৳${config.minOrderAmount} required` };
  }

  // Calculate max discount allowed (e.g., 50% of order)
  const maxDiscount = Math.floor(orderTotal * config.maxRedeemPercent / 100);
  const requestedDiscount = Math.floor(pointsToRedeem / config.pointsPerBdt);

  let actualDiscount = requestedDiscount;
  let actualPoints = pointsToRedeem;

  // Cap if exceeds max
  if (requestedDiscount > maxDiscount) {
    actualDiscount = maxDiscount;
    actualPoints = maxDiscount * config.pointsPerBdt;
  }

  return {
    valid: true,
    discountAmount: actualDiscount,
    pointsToRedeem: actualPoints,
    maxAllowedPoints: maxDiscount * config.pointsPerBdt
  };
}

// Example:
// pointsToRedeem = 100, customerPoints = 500, orderTotal = 950
// config.pointsPerBdt = 10, config.maxRedeemPercent = 50
// Returns: { valid: true, discountAmount: 10, pointsToRedeem: 100, maxAllowedPoints: 4750 }
```

**2.3 Calculate Points to Earn**

```javascript
function calculatePointsToEarn(finalTotal, tierName) {
  if (!membershipConfig || finalTotal <= 0) return 0;

  const { pointsPerAmount = 1, amountPerPoint = 100, roundingMode = 'floor' } = membershipConfig;
  const basePoints = (finalTotal / amountPerPoint) * pointsPerAmount;

  // Apply tier multiplier
  let multiplier = 1;
  if (tierName && membershipConfig.tiers) {
    const tier = membershipConfig.tiers.find(t => t.name === tierName);
    if (tier?.pointsMultiplier) {
      multiplier = tier.pointsMultiplier;
    }
  }

  const points = basePoints * multiplier;

  // Apply rounding mode
  switch (roundingMode) {
    case 'ceil': return Math.ceil(points);
    case 'round': return Math.round(points);
    case 'floor':
    default: return Math.floor(points);
  }
}

// Example:
// finalTotal = 940, tier = 'Gold' (1.5x multiplier)
// amountPerPoint = 100, pointsPerAmount = 1
// Returns: floor((940 / 100) * 1 * 1.5) = floor(14.1) = 14 points
```

**2.4 Complete Order Calculation (Matches Server Logic)**

```javascript
function calculateOrderTotals(cart, customer, pointsToRedeem = 0) {
  // Step 1: Calculate subtotal
  const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const manualDiscount = cart.manualDiscount || 0;
  const deliveryCharge = cart.deliveryMethod === 'delivery' ? cart.deliveryCharge : 0;
  const customerTier = customer?.membership?.tier || null;
  const customerPoints = customer?.membership?.points?.current || 0;

  // Step 2: Tier discount (on subtotal)
  const tierDiscount = calculateTierDiscount(subtotal, customerTier);

  // Step 3: Preliminary total (before redemption)
  const preliminaryTotal = Math.max(0, subtotal - manualDiscount - tierDiscount + deliveryCharge);

  // Step 4: Points redemption
  let redemptionDiscount = 0;
  let actualPointsRedeemed = 0;
  let redemptionError = null;

  if (pointsToRedeem > 0) {
    const result = validateRedemption(pointsToRedeem, customerPoints, preliminaryTotal);
    if (result.valid) {
      redemptionDiscount = result.discountAmount;
      actualPointsRedeemed = result.pointsToRedeem;
    } else {
      redemptionError = result.error;
    }
  }

  // Step 5: Final total
  const total = preliminaryTotal - redemptionDiscount;

  // Step 6: Points to earn (on final total)
  const pointsToEarn = calculatePointsToEarn(total, customerTier);

  return {
    subtotal,
    manualDiscount,
    tierDiscount,
    redemptionDiscount,
    totalDiscount: manualDiscount + tierDiscount + redemptionDiscount,
    deliveryCharge,
    total,
    pointsToEarn,
    pointsRedeemed: actualPointsRedeemed,
    redemptionError,
  };
}
```

#### Step 3: Real-Time UI Updates

**3.1 Cart Total Display**

```javascript
// On every cart change (item scan, quantity change, etc.)
function updateCartDisplay() {
  const breakdown = calculateOrderTotals(cart, currentCustomer, pointsToRedeemInput);

  document.getElementById('subtotal').textContent = `৳${breakdown.subtotal}`;
  document.getElementById('tier-discount').textContent = breakdown.tierDiscount > 0
    ? `-৳${breakdown.tierDiscount}`
    : '-';
  document.getElementById('redemption-discount').textContent = breakdown.redemptionDiscount > 0
    ? `-৳${breakdown.redemptionDiscount}`
    : '-';
  document.getElementById('total').textContent = `৳${breakdown.total}`;
  document.getElementById('points-to-earn').textContent = `+${breakdown.pointsToEarn} pts`;

  if (breakdown.redemptionError) {
    showError(breakdown.redemptionError);
  }
}

// Call on every change
cart.on('change', updateCartDisplay);
pointsInput.on('input', updateCartDisplay);
```

**3.2 Membership Card Scan**

```javascript
async function onMembershipCardScanned(cardId) {
  // Fetch customer from cache or API (one-time per order)
  const customer = await lookupCustomer(cardId);

  if (!customer) {
    showError('Membership card not found');
    return;
  }

  currentCustomer = customer;

  // Show tier badge with color
  const tierColor = getTierColor(customer.membership.tier);
  showTierBadge(customer.membership.tier, tierColor);

  // Show available points
  showAvailablePoints(customer.membership.points.current);

  // Recalculate totals with tier discount
  updateCartDisplay();

  // Enable points redemption input
  enableRedemptionInput(customer.membership.points.current);
}

// Define tier colors in your frontend app (not fetched from server)
const TIER_COLORS = {
  'Bronze': '#CD7F32',
  'Silver': '#C0C0C0',
  'Gold': '#FFD700',
  'Platinum': '#E5E4E2'
};

function getTierColor(tierName) {
  return TIER_COLORS[tierName] || '#808080'; // Default gray for unknown tiers
}
```

**3.3 Points Redemption Slider (Real-Time Preview)**

```html
<!-- POS UI Example -->
<div class="redemption-panel">
  <label>Redeem Points (Available: <span id="available-points">0</span>)</label>
  <input type="range" id="points-slider" min="0" max="0" step="10" value="0">
  <input type="number" id="points-input" value="0">

  <div class="discount-preview">
    Discount: <span id="redemption-discount-preview">৳0</span>
  </div>

  <button id="apply-redemption">Apply</button>
</div>

<script>
// Real-time slider update
document.getElementById('points-slider').addEventListener('input', (e) => {
  const points = parseInt(e.target.value);
  document.getElementById('points-input').value = points;

  // Instant calculation (no server call)
  const breakdown = calculateOrderTotals(cart, currentCustomer, points);

  document.getElementById('redemption-discount-preview').textContent = `৳${breakdown.redemptionDiscount}`;
  document.getElementById('total').textContent = `৳${breakdown.total}`;

  if (breakdown.redemptionError) {
    showError(breakdown.redemptionError);
  }
});
</script>
```

#### Step 4: Tier Color Coding & Visual Hierarchy

Define tier colors in your frontend for instant visual feedback. Colors are UI concerns and not stored in backend.

```css
/* Tier badge colors (defined in frontend) */
.tier-badge.bronze { background: #CD7F32; }
.tier-badge.silver { background: #C0C0C0; }
.tier-badge.gold { background: #FFD700; }
.tier-badge.platinum { background: #E5E4E2; }

/* Discount breakdown colors */
.discount-tier { color: #FFD700; } /* Gold accent for tier discount */
.discount-redemption { color: #00A86B; } /* Green for points redemption */
.points-earned { color: #0066FF; } /* Blue for points to earn */
```

**Frontend Color Mapping:**

```javascript
// Define once in your app
const TIER_COLORS = {
  'Bronze': '#CD7F32',
  'Silver': '#C0C0C0',
  'Gold': '#FFD700',
  'Platinum': '#E5E4E2'
};

// Use in components
function renderTierBadge(tierName) {
  const color = TIER_COLORS[tierName] || '#808080';
  return `<span class="tier-badge" style="background: ${color}">${tierName}</span>`;
}
```

**Example Receipt/Display:**

```
┌─────────────────────────────────────┐
│ MEMBERSHIP: MBR-12345678            │
│ [Gold Badge] Gold Tier              │
│ Current Points: 2,015               │
└─────────────────────────────────────┘

Subtotal:                      ৳1,000
Tier Discount (5%):              -৳50 ⭐
Points Redeemed (100 pts):       -৳10 🎁
────────────────────────────────────
Total:                           ৳940

Points Earned: +14 pts 🔵
New Balance: 1,929 pts
```

#### Step 5: Performance Considerations

**✅ FAST (Recommended):**
- Cache membership config on app load (5-min TTL)
- Calculate discounts client-side for preview
- Single API call for final checkout

**❌ SLOW (Avoid):**
- API call for every item scan
- API call for every points input change
- Fetching config on every calculation

**Benchmarks:**
| Approach | Latency per Update | User Experience |
|----------|-------------------|-----------------|
| Client-side calculation | <5ms | Instant, smooth |
| Server validation per change | 150-300ms | Noticeable lag |
| No preview | N/A | Poor UX |

#### Step 6: Security & Data Integrity

**Important Rules:**

1. **Server is Source of Truth**
   - Client calculations are for preview ONLY
   - Server recalculates everything on checkout
   - Prevents tampering (client can't cheat discounts)

2. **Send Minimal Data to Server**
   ```javascript
   // ✅ Good: Send only inputs
   {
     items: [...],
     membershipCardId: 'MBR-12345678',
     pointsToRedeem: 100
   }

   // ❌ Bad: Don't send calculated discounts
   {
     items: [...],
     tierDiscount: 50, // Server ignores this
     redemptionDiscount: 10 // Server ignores this
   }
   ```

3. **Handle Mismatch Gracefully**
   ```javascript
   // After server response
   if (serverTotal !== clientTotal) {
     console.warn('Client/server mismatch', { clientTotal, serverTotal });
     // Show server values (they are correct)
     updateCartDisplay(serverResponse);
   }
   ```

4. **Validate Config Integrity**
   ```javascript
   function isValidConfig(config) {
     return config?.enabled &&
            Array.isArray(config.tiers) &&
            config.redemption?.pointsPerBdt > 0;
   }

   if (!isValidConfig(membershipConfig)) {
     // Disable client-side preview, rely on server
     console.warn('Invalid membership config, preview disabled');
   }
   ```

#### Step 7: Testing Client-Side Calculations

**Unit Tests:**

```javascript
describe('POS Calculations', () => {
  const mockConfig = {
    enabled: true,
    pointsPerAmount: 1,
    amountPerPoint: 100,
    roundingMode: 'floor',
    tiers: [
      { name: 'Gold', minPoints: 2000, pointsMultiplier: 1.5, discountPercent: 5 }
    ],
    redemption: {
      enabled: true,
      minRedeemPoints: 100,
      pointsPerBdt: 10,
      maxRedeemPercent: 50
    }
  };

  beforeEach(() => {
    membershipConfig = mockConfig;
  });

  test('calculates tier discount correctly', () => {
    expect(calculateTierDiscount(1000, 'Gold')).toBe(50);
  });

  test('validates redemption within limits', () => {
    const result = validateRedemption(100, 500, 950);
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(10);
  });

  test('caps redemption at maxRedeemPercent', () => {
    const result = validateRedemption(10000, 10000, 100);
    // 50% of 100 = 50 BDT = 500 points max
    expect(result.pointsToRedeem).toBe(500);
    expect(result.discountAmount).toBe(50);
  });

  test('calculates complete order totals', () => {
    const cart = {
      items: [{ price: 1000, quantity: 1 }],
      manualDiscount: 0,
      deliveryCharge: 0
    };
    const customer = {
      membership: { tier: 'Gold', points: { current: 500 } }
    };

    const breakdown = calculateOrderTotals(cart, customer, 100);

    expect(breakdown.subtotal).toBe(1000);
    expect(breakdown.tierDiscount).toBe(50); // 5% of 1000
    expect(breakdown.redemptionDiscount).toBe(10); // 100 pts / 10
    expect(breakdown.total).toBe(940); // 1000 - 50 - 10
    expect(breakdown.pointsToEarn).toBe(14); // floor((940/100) * 1.5)
  });
});
```

**Integration Test:**

```javascript
// Verify client calculations match server
async function testCalculationAccuracy() {
  const testCart = {
    items: [{ productId: 'xxx', quantity: 2, price: 500 }],
    membershipCardId: 'MBR-12345678',
    pointsToRedeem: 100
  };

  // Client-side preview
  const clientResult = calculateOrderTotals(testCart, customer, 100);

  // Server validation
  const serverResponse = await createPOSOrder(testCart);

  // Assert they match
  assert.equal(clientResult.total, serverResponse.data.totalAmount);
  assert.equal(clientResult.tierDiscount, serverResponse.data.membershipApplied.tierDiscountApplied);
  assert.equal(clientResult.redemptionDiscount, serverResponse.data.membershipApplied.pointsRedemptionDiscount);
}
```

#### Summary: Client-Side Implementation Checklist

- [ ] Cache platform config on POS app load
- [ ] Implement `calculateTierDiscount()` function
- [ ] Implement `validateRedemption()` function
- [ ] Implement `calculatePointsToEarn()` function
- [ ] Implement `calculateOrderTotals()` function (matches server logic)
- [ ] Update cart display on every change (instant preview)
- [ ] Fetch customer once on card scan, cache for order
- [ ] Use tier colors for visual hierarchy
- [ ] Handle config reload (every 5 mins or manual refresh)
- [ ] Test calculations match server response
- [ ] Handle client/server mismatch gracefully
- [ ] Disable preview if config invalid (fallback to server)

**Result:** Fast, responsive POS with instant discount previews and no lag during checkout.

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
