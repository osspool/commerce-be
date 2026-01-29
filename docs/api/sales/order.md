# Order API Integration Guide

Quick reference for frontend integration with the Order API.

> **Quick Start:** For checkout implementation, see [Checkout API](checkout.md)

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/orders` | User | Create order (checkout from cart) |
| `GET` | `/api/v1/orders/my` | User | List my orders |
| `GET` | `/api/v1/orders/my/:id` | User | Get my order detail |
| `POST` | `/api/v1/orders/:id/cancel` | User/Admin | Cancel order (owner or admin) |
| `POST` | `/api/v1/orders/:id/cancel-request` | User/Admin | Request cancellation (await admin review) |
| `GET` | `/api/v1/orders/:id` | Authenticated | Get order by ID |
| `PATCH` | `/api/v1/orders/:id` | Admin | Update order (admin CRUD) |
| `DELETE` | `/api/v1/orders/:id` | Admin | Delete order (admin CRUD) |
| `GET` | `/api/v1/orders` | Admin | List all orders |
| `PATCH` | `/api/v1/orders/:id/status` | Admin | Update order status |
| `POST` | `/api/v1/orders/:id/fulfill` | Admin | Ship order |
| `POST` | `/api/v1/orders/:id/refund` | Admin | Refund order |
| `POST` | `/api/v1/orders/:id/shipping` | Admin | Create shipping (manual or RedX API) |
| `PATCH` | `/api/v1/orders/:id/shipping` | Admin | Update shipping status |
| `GET` | `/api/v1/orders/:id/shipping` | User/Admin | Get shipping info |
| `POST` | `/webhooks/payments/manual/verify` | Superadmin | Verify manual payment (bkash/nagad/bank_transfer/cash) |
| `POST` | `/webhooks/payments/manual/reject` | Superadmin | Reject manual payment (invalid/fraud) |

**Logistics Utilities**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/logistics/pickup-stores` | Admin | List RedX pickup stores |
| `GET` | `/api/v1/logistics/shipments/:id/track` | Admin | Track shipment via provider API |
| `POST` | `/api/v1/logistics/shipments/:id/cancel` | Admin | Cancel shipment via provider API |
| `GET` | `/api/v1/logistics/charge` | Public | Estimate delivery charge by zone |

---

## Checkout Flow (Cart → Order)

```
1. Add items to cart     → POST /api/v1/cart/items
2. Fetch checkout data   → GET /api/v1/cart + GET /api/v1/platform/config?select=paymentMethods,checkout
3. Create order          → POST /api/v1/orders
```

**Backend automatically:** Fetches cart, validates coupon, calculates prices, reserves stock, creates order + transaction, clears cart.

> **Stock:** Reserved at checkout, committed at fulfillment. Auto-expires if not fulfilled.
> **Payment failure:** Order cancelled, stock released immediately.

---

## VAT Calculation & Invoice Generation

Orders automatically calculate VAT based on Bangladesh NBR (National Board of Revenue) regulations.

### How VAT Works in Orders

**3-Tier Cascade Resolution:**
1. Each order item's VAT rate is resolved at checkout time using the cascade:
   - `Variant.vatRate` → `Product.vatRate` → `Category.vatRate` → `Platform.vat.defaultRate`
2. Rates are **snapshot** into order items (frozen forever)
3. Total order VAT is sum of all line item VAT amounts

**VAT Applicability:**
- VAT is only calculated when `platform.vat.isRegistered = true`
- When disabled, all orders get `vat.applicable = false` and `vat.amount = 0`
- Individual products can be exempt (`vatRate: 0`) even when VAT is enabled

### VAT Invoice Numbering

**Format:** `INV-{BRANCHCODE}-{YYYYMMDD}-{NNNN}`

**Example:** `INV-DK-20251221-0042`
- `DK` = Branch code (Dhaka)
- `20251221` = Date (Asia/Dhaka timezone)
- `0042` = Daily sequence number (padded to 4 digits)

**When Invoices Are Issued:**

| Scenario | Invoice Issued At | Branch Used |
|----------|------------------|-------------|
| Web checkout (branch selected) | Checkout time | Selected branch |
| Web checkout (no branch) | Fulfillment time | Fulfillment branch |
| POS checkout | Checkout time | POS branch (required) |

**Sequence Reset:**
- Counter resets daily per branch (each branch has independent sequences)
- Sequence starts at 1 each day
- Stored in `VatInvoiceCounter` collection

### Order VAT Breakdown Example

**Order Response:**
```json
{
  "_id": "order_123",
  "subtotal": 1150,
  "discountAmount": 50,
  "deliveryCharge": 60,
  "totalAmount": 1160,
  "vat": {
    "applicable": true,
    "rate": 15,
    "amount": 150.87,
    "pricesIncludeVat": true,
    "taxableAmount": 1009.13,
    "sellerBin": "1234567890123",
    "invoiceNumber": "INV-DK-20251221-0042",
    "invoiceIssuedAt": "2025-12-21T10:30:00.000Z",
    "invoiceBranch": "branch_id",
    "invoiceDateKey": "20251221"
  },
  "items": [
    {
      "productName": "Rice (Miniket)",
      "quantity": 2,
      "price": 65,
      "vatRate": 5,
      "vatAmount": 6.19
    },
    {
      "productName": "Laptop",
      "quantity": 1,
      "price": 45000,
      "vatRate": 15,
      "vatAmount": 5869.57
    },
    {
      "productName": "Educational Book",
      "quantity": 1,
      "price": 500,
      "vatRate": 0,
      "vatAmount": 0
    }
  ]
}
```

**Notes:**
- Mixed VAT rates in single order (5%, 15%, 0% exempt)
- Each item's `vatRate` is frozen at checkout
- Total `vat.amount` is sum of all line item `vatAmount` values
- Delivery charge VAT is included in total (extracted if `pricesIncludeVat: true`)

### VAT Configuration

**See Also:**
- [Product API - VAT Rate Configuration](../catalog/product.md#vat-rate-configuration) - Set product/variant-level rates
- [Category API - VAT Rate Configuration](../catalog/category.md#vat-rate-configuration) - Set category-level rates
- [Platform API - VAT Configuration](../platform/platform.md) - Configure platform-wide VAT settings

### VAT in Financial Transactions

Order VAT data automatically flows to the associated Transaction for finance/accounting reporting:

**Transaction Tax Fields (populated from Order):**

| Transaction Field | Order Source | Description |
|------------------|--------------|-------------|
| `tax` | `vat.amount × 100` | VAT amount in paisa |
| `taxDetails.type` | `'vat'` | Tax type |
| `taxDetails.rate` | `vat.rate / 100` | Rate as decimal (0.15) |
| `taxDetails.isInclusive` | `vat.pricesIncludeVat` | Whether prices include VAT |
| `taxDetails.jurisdiction` | `'BD'` | Bangladesh |

**Example Transaction (from Order):**
```json
{
  "_id": "txn_id",
  "flow": "inflow",
  "type": "order_purchase",
  "amount": 230000,
  "tax": 30000,
  "net": 200000,
  "sourceModel": "Order",
  "sourceId": "order_id",
  "taxDetails": {
    "type": "vat",
    "rate": 0.15,
    "isInclusive": true,
    "jurisdiction": "BD"
  }
}
```

**Refund Tax Handling:**
- Full refund: Refund transaction receives full original tax
- Partial refund: Tax is proportional (`refundTax = originalTax × refundAmount / originalAmount`)

**See Also:** [Transaction API - Tax/VAT Support](../finance/transaction.md#taxvat-support-in-transactions)

---

## Customer Endpoints

### Create Order (Checkout)

```http
POST /api/v1/orders
Authorization: Bearer <token>
```

**Checkout page data sources:**
- **Cart:** `GET /api/v1/cart` → display cart items (read-only for FE)
- **Config:** `GET /api/v1/platform/config?select=paymentMethods,checkout` → payment methods + checkout settings

**Backend automatically:**
- Fetches cart items (only source for products)
- Calculates pricing with variation modifiers
- Validates coupon and applies discount
- Resolves VAT rates via 3-tier cascade (Variant → Product → Category → Platform)
- Calculates VAT breakdown and generates invoice number (if branch selected)
- Reserves stock atomically (temporary hold)
- Creates order + transaction
- Clears cart on success
- Commits/decrements stock on fulfillment (admin)

#### Example: Cash on Delivery (COD)

```json
{
  "deliveryAddress": {
    "recipientName": "Karim Ahmed",
    "recipientPhone": "01712345678",
    "addressLine1": "House 45, Road 12",
    "areaId": 2,
    "areaName": "Dhanmondi",
    "zoneId": 1,
    "city": "Dhaka"
  },
  "delivery": { "method": "standard", "price": 60 },
  "paymentData": { "type": "cash" },
  "couponCode": "SAVE10"
}
```

#### Example: bKash Payment

```json
{
  "deliveryAddress": { /* same as above */ },
  "delivery": { "method": "express", "price": 120 },
  "paymentData": {
    "type": "bkash",
    "reference": "BGH3K5L90P",
    "senderPhone": "01712345678"
  }
}
```

> **Gift orders:** Add `"isGift": true` to the payload. Use `deliveryAddress.recipientName` for the gift recipient.

#### Request Body Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idempotencyKey` | string | No | Idempotency key for safely retrying checkout without creating duplicate orders |
| `deliveryAddress` | object | Yes | Delivery address details |
| `deliveryAddress.recipientName` | string | Yes | Recipient name (required for delivery / logistics labels) |
| `deliveryAddress.recipientPhone` | string | Yes | Contact phone for delivery (`01XXXXXXXXX`) |
| `deliveryAddress.addressLine1` | string | Yes | Street address |
| `deliveryAddress.areaId` | number | Yes | Area ID from bd-areas constants |
| `deliveryAddress.areaName` | string | Yes | Area name (e.g., "Mohammadpur") |
| `deliveryAddress.zoneId` | number | Yes | Zone ID for pricing (1-6) |
| `deliveryAddress.city` | string | Yes | City/District name |
| `deliveryAddress.addressLine2` | string | No | Additional address info |
| `deliveryAddress.division` | string | No | Division name |
| `deliveryAddress.postalCode` | string | No | Postal code |
| `deliveryAddress.providerAreaIds` | object | No | Provider-specific area IDs (redx, pathao) |
| `delivery` | object | Yes | Delivery method and pricing |
| `delivery.method` | string | Yes | Delivery method name (from platform config) |
| `delivery.price` | number | Yes | Delivery price in BDT (from platform config or area estimate) |
| `isGift` | boolean | No | True if ordering on behalf of someone else (use `recipientName` in `deliveryAddress`) |
| `couponCode` | string | No | Coupon code for discount (validated by backend) |
| `branchId` | string | No | Preferred fulfillment branch ID (affects stock reservation + cost lookup) |
| `branchSlug` | string | No | Preferred fulfillment branch slug (alternative to `branchId`) |
| `notes` | string | No | Order notes |
| `paymentData` | object | No | Payment information (defaults to `cash` if omitted) |
| `paymentData.type` | string | Yes* | Payment type: `cash`, `bkash`, `nagad`, `rocket`, `bank_transfer`, `card` |
| `paymentData.reference` | string | No | Customer's payment TrxID (recommended for verification) |
| `paymentData.senderPhone` | string | Yes (wallets) | Sender phone for mobile wallet payments (`01XXXXXXXXX`) |

> **Notes:**
> - **Manual Gateway:** Frontend only needs to send `type`, `reference`, and `senderPhone`. Advanced fields like `paymentDetails`, `gateway` are library-managed for automated gateways (Stripe, SSLCommerz, bKash API)
> - Cart items are fetched automatically by backend (only source for products)
> - Backend calculates all prices (product + variant modifier + delivery - coupon)
> - FE passes delivery method + price from platform config
> - Cart is cleared automatically after successful order
> - `paymentData.type` is required **only if** `paymentData` is provided. If `paymentData` is omitted, backend treats it as `cash`.

---

## Manual Payment Verification (Admin)

Mounted outside `/api/v1` (registered at `/webhooks/payments` in `index.factory.js`).

### Verify Manual Payment
```http
POST /webhooks/payments/manual/verify
Authorization: Bearer <superadmin token>
```
Payload:
```json
{
  "transactionId": "507f1f77bcf86cd799439011",
  "notes": "Verified bKash TrxID: ABC123"
}
```
Result:
- Transaction → `verified`
- Order payment → `verified`; order status → `confirmed` (if pending)

### Reject Manual Payment
```http
POST /webhooks/payments/manual/reject
Authorization: Bearer <superadmin token>
```
Payload:
```json
{
  "transactionId": "507f1f77bcf86cd799439011",
  "reason": "Invalid bKash TrxID"
}
```
Result:
- Transaction → `failed` (stores reason)
- Order payment → `failed` (timeline event recorded)

**Reject Response:**
```json
{
  "success": true,
  "message": "Payment rejected",
  "data": {
    "transactionId": "txn_id",
    "status": "failed",
    "failedAt": "2025-01-12T10:00:00.000Z",
    "failureReason": "Invalid bKash TrxID"
  }
}
```

---

### Create Order Response

**Success Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "order_id",
    "status": "pending",
    "currentPayment": {
      "transactionId": "txn_id",
      "amount": 156000,
      "status": "pending",
      "method": "bkash",
      "reference": "BGH3K5L90P"
    },
    "subtotal": 1500,
    "discountAmount": 0,
    "deliveryCharge": 60,
    "totalAmount": 1560,
    "items": [...]
  },
  "transaction": "txn_id",
  "paymentIntent": null,
  "message": "Order created successfully"
}
```

> **Note:** `paymentIntent` is returned for automated payment gateways (Stripe, SSLCommerz). For manual payments it's `null`.
> **Note:** `currentPayment.amount` is stored in **paisa** (smallest unit). Convert to BDT for display.
> **Note:** If the same `idempotencyKey` is reused with identical payload, backend returns **200** with `{ cached: true }` instead of creating a new order.

---

### Get My Orders

```http
GET /api/v1/orders/my?page=1&limit=10&status=pending
Authorization: Bearer <token>
```

**Query params:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `status` - Filter by status (optional)
- `sort` - Sort field (default: `-createdAt`)

**Response:**
```json
{
  "success": true,
  "docs": [...],
  "total": 25,
  "page": 1,
  "pages": 3,
  "hasNext": true,
  "hasPrev": false
}
```

---

### Get My Order Detail

```http
GET /api/v1/orders/my/:id
Authorization: Bearer <token>
```

---

### Cancel Order

```http
POST /api/v1/orders/:id/cancel
Authorization: Bearer <token>
```

**Request:**
```json
{
  "reason": "Changed my mind"
}
```

> Notes:
> - Users can cancel their own orders; admins can cancel any order.
> - Cancellation is blocked only when the order is already `cancelled` or `delivered` (otherwise allowed).
> - Set `refund: true` to trigger a refund when payment is verified.
> - **Membership Points:** If customer redeemed points during checkout, they are automatically restored to their account on cancellation. See [Customer API - Points Lifecycle](customer.md#points-lifecycle--restoration).

---

### Request Order Cancellation

```http
POST /api/v1/orders/:id/cancel-request
Authorization: Bearer <token>
```

**Request:**
```json
{
  "reason": "Changed my mind"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "cancellationRequest": {
      "requested": true,
      "reason": "Changed my mind",
      "requestedAt": "2025-12-08T10:00:00.000Z",
      "requestedBy": "user_id"
    }
  },
  "message": "Cancellation requested. Awaiting admin review."
}
```

> Notes:
> - This endpoint requests cancellation and queues it for admin review (does not immediately cancel).
> - Users can request cancellation for their own orders; admins can request for any order.
> - Request is blocked only when the order is already `cancelled` or `delivered`.
> - Admin can then approve by using the direct cancel endpoint above.

---

### Update Order (Admin CRUD)

```http
PATCH /api/v1/orders/:id
Authorization: Bearer <admin_token>
```

Use for administrative field updates supported by the model (e.g., metadata). For status changes prefer the dedicated `/status` endpoint.

---

### Delete Order (Admin CRUD)

```http
DELETE /api/v1/orders/:id
Authorization: Bearer <admin_token>
```

Admin-only hard delete. Prefer cancellations/refunds for customer-impacting cases.

---

## Order Status Flow

```
pending → processing → confirmed → shipped → delivered
    ↓         ↓            ↓
 cancelled  cancelled   cancelled
```

| Status | Description |
|--------|-------------|
| `pending` | Order placed, awaiting payment verification |
| `processing` | Payment verified, preparing order |
| `confirmed` | Order confirmed, ready to ship |
| `shipped` | Order dispatched |
| `delivered` | Order delivered |
| `cancelled` | Order cancelled |

---

## Payment Status Flow

```
pending → verified → (refunded)
    ↓
  failed
```

| Status | Description |
|--------|-------------|
| `pending` | Awaiting payment |
| `verified` | Payment confirmed |
| `failed` | Payment failed |
| `refunded` | Full refund processed |
| `partially_refunded` | Partial refund processed |
| `cancelled` | Payment cancelled |

---

## Branch & Inventory Management

### Branch Selection

Branches (stores/warehouses) are an **internal concern** - customers don't need to know about them.

**For Web Orders:**
- Customers don't pass branch at checkout
- Branch is determined at **fulfillment** by admin
- Admin can specify `branchId` or `branchSlug` when fulfilling

**For POS Orders:**
- Branch is required (staff knows which store they're at)
- Inventory decremented immediately at checkout

**For Fulfillment (Admin):**
- Priority: `branchId`/`branchSlug` in request > default branch
- If not specified, uses default branch (auto-created if none exists)

```javascript
// Admin fulfill with branch
POST /api/v1/orders/:id/fulfill
{
  "branchSlug": "dhaka-warehouse",
  "trackingNumber": "REDX123"
}

// Or use default branch (omit branchId/branchSlug)
POST /api/v1/orders/:id/fulfill
{
  "trackingNumber": "REDX123"
}
```

### Inventory Deduction Timing

| Channel | When Inventory Decrements | Branch Source |
|---------|--------------------------|---------------|
| **Web Orders** | At fulfillment (admin ships) | Fulfill request > default branch |
| **POS Pickup** | At checkout (immediate) | Required at checkout |
| **POS Delivery** | At checkout (immediate) | Required at checkout |

### Default Branch

If no branch is specified:
1. System looks for a branch with `isDefault: true`
2. If no default exists, creates "Main Store" branch automatically
3. All inventory operations use this branch

**Get default branch:**
```http
GET /api/v1/branches/default
```

### Inventory Flow Example

```
WEB ORDER:
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Checkout   │ ──► │ Order Created│ ──► │  Fulfilled  │
│ (no decr.)  │     │ (no branch)  │     │ branch: X   │
└─────────────┘     └──────────────┘     │ stock: -qty │
                                         └─────────────┘

POS ORDER:
┌─────────────┐     ┌──────────────┐
│  Checkout   │ ──► │ Order Created│
│ branch: X   │     │ branch: X    │
│ stock: -qty │     │ status: done │
└─────────────┘     └──────────────┘
```

### Multi-Branch Considerations

- **Cost prices:** Vary by branch; specify branch for accurate profit calculation (visibility is role-based via `config/sections/costPrice.config.js`)
- **Stock levels:** `product.quantity` is sum of all branches
- **Per-branch stock (API)**: There is **no public “list StockEntry”** endpoint. Use:
  - `GET /api/v1/pos/products?branchId=...` for POS catalog + `branchStock`
  - `GET /api/v1/inventory/movements?branchId=...&productId=...` for audit trail
- **Fulfillment routing:** Orders show `order.branch` indicating fulfillment source

---

## Key Response Fields

```typescript
interface Order {
  _id: string;
  orderNumber?: string;            // Virtual: last 8 chars of _id (uppercase)
  source: 'web' | 'pos' | 'api';  // Order channel
  branch?: string;                // Branch ID for fulfillment (set at checkout or fulfillment)
  customer: string;
  customerName: string;           // Snapshot: Buyer's name at order time
  customerPhone?: string;         // Snapshot: Buyer's phone
  customerEmail?: string;         // Snapshot: Buyer's email
  userId?: string;                // Link to user account (if logged in)
  status: 'pending' | 'processing' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

  // POS-specific fields
  terminalId?: string;            // POS terminal identifier
  cashier?: string;               // Staff member who processed (User ID)
  idempotencyKey?: string;        // Idempotency key for retries

  // Stock reservation (web checkout)
  stockReservationId?: string;    // Reservation ID for stock hold
  stockReservationExpiresAt?: Date;

  // Payment info
  currentPayment: {
    transactionId: string;
    amount: number;        // In paisa (smallest unit)
    status: 'pending' | 'verified' | 'failed' | 'refunded' | 'partially_refunded' | 'cancelled';
    method: string;
    reference?: string;    // Customer's payment TrxID (e.g., bKash: BGH3K5L90P)
    verifiedAt?: Date;
    verifiedBy?: string;
  };

  // Totals (in BDT)
  subtotal: number;
  discountAmount: number;
  deliveryCharge: number;  // Delivery charge in BDT
  totalAmount: number;

  // VAT breakdown (Bangladesh NBR compliant)
  // VAT rates are resolved via 3-tier cascade: Variant → Product → Category → Platform
  // Rates are snapshot at checkout time (changing product VAT doesn't affect historical orders)
  vat?: {
    applicable: boolean;              // True if platform.vat.isRegistered = true
    rate: number;                     // Dominant VAT rate (for display)
    amount: number;                   // Total VAT amount for order
    pricesIncludeVat: boolean;        // Whether prices include VAT (BD default: true)
    taxableAmount: number;            // Net amount before VAT
    sellerBin?: string | null;        // Business Identification Number (13 digits)
    invoiceNumber?: string | null;    // INV-{BRANCHCODE}-{YYYYMMDD}-{NNNN}
    invoiceIssuedAt?: Date | null;    // Invoice issue timestamp (Asia/Dhaka timezone)
    invoiceBranch?: string | null;    // Branch ID that issued the invoice
    invoiceDateKey?: string | null;   // YYYYMMDD (Asia/Dhaka) for daily sequence
  };

  // Items (snapshots from cart at checkout time)
  // All fields are frozen at order creation - changes to products don't affect historical orders
  items: Array<{
    product: string;
    productName: string;
    productSlug?: string;
    quantity: number;
    price: number;
    // Variant info (for variant products)
    variantSku?: string;                           // e.g., "TSHIRT-M-RED"
    variantAttributes?: Record<string, string>;    // e.g., { size: "M", color: "Red" }
    variantPriceModifier?: number;                 // Price modifier snapshot
    costPriceAtSale?: number;                      // Cost price snapshot (role-based: costPrice.viewRoles)
    // VAT info (snapshot at checkout via 3-tier cascade)
    vatRate?: number;                              // VAT rate % applied (0-100, resolved from variant→product→category→platform)
    vatAmount?: number;                            // Calculated VAT amount for this line item
  }>;

  // Delivery
  delivery: { method: string; price: number };
  deliveryAddress: {
    recipientName?: string;         // Gift recipient (if isGift: true)
    recipientPhone: string;         // Contact phone for delivery
    addressLine1: string;
    areaId: number;                 // From bd-areas constants
    areaName: string;               // e.g., "Mohammadpur"
    zoneId: number;                 // Zone ID for pricing (1-6)
    city: string;                   // District/City
    postalCode?: string;
    providerAreaIds?: {             // Provider-specific IDs
      redx?: number;
      pathao?: number;
    };
  };
  isGift: boolean;                  // True if ordering on behalf of someone

  // Coupon applied (if any)
  couponApplied?: {
    coupon: string;               // Coupon ID
    code: string;                 // Coupon code used
    discountType: 'percentage' | 'fixed';
    discountValue: number;        // Original coupon value (e.g., 10 for 10%)
    discountAmount: number;       // Actual discount applied to order
  };

  // Parcel metrics (for delivery estimation)
  parcel?: {
    weightGrams: number;          // Total weight in grams
    dimensionsCm?: {
      length: number;
      width: number;
      height: number;
    };
    missingWeightItems: number;   // Items without weight data
    missingDimensionItems: number;
  };

  // Cancellation request
  cancellationRequest?: {
    requested: boolean;
    reason?: string;
    requestedAt?: Date;
    requestedBy?: string;
  };
  cancellationReason?: string;

  // Shipping (consolidated - all shipment data embedded in Order)
  shipping?: {
    provider: 'redx' | 'pathao' | 'steadfast' | 'paperfly' | 'sundarban' | 'sa_paribahan' | 'dhl' | 'fedex' | 'manual' | 'other';
    status: 'pending' | 'requested' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'failed_attempt' | 'returned' | 'cancelled';
    trackingNumber?: string;
    providerOrderId?: string;      // Provider's internal ID
    providerStatus?: string;       // Raw status from provider (for debugging)
    trackingUrl?: string;
    labelUrl?: string;
    consignmentId?: string;
    estimatedDelivery?: Date;
    requestedAt?: Date;
    pickedUpAt?: Date;
    deliveredAt?: Date;
    // Pickup info (for provider API shipments)
    pickup?: {
      storeId?: number;
      storeName?: string;
      scheduledAt?: Date;
    };
    // Provider charges breakdown
    charges?: {
      deliveryCharge: number;
      codCharge: number;
      totalCharge: number;
    };
    // Cash on delivery tracking
    cashCollection?: {
      amount: number;
      collected: boolean;
      collectedAt?: Date;
    };
    // Webhook tracking
    lastWebhookAt?: Date;
    webhookCount?: number;
    metadata?: object;
    history: Array<{
      status: string;
      note?: string;
      noteLocal?: string;      // Bengali/local language note
      actor?: string;
      timestamp: Date;
      raw?: object;            // Raw provider response for debugging
    }>;
  };
  
  // Virtuals (backward compat)
  trackingNumber?: string;
  shippedAt?: Date;
  deliveredAt?: Date;
  shippingStatus?: string;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Admin Endpoints (Dashboard)

### List All Orders

```http
GET /api/v1/orders?page=1&limit=20&status=pending
Authorization: Bearer <admin_token>
```

### Update Order Status

```http
PATCH /api/v1/orders/:id/status
Authorization: Bearer <admin_token>
```

**Request:**
```json
{
  "status": "confirmed",
  "note": "Payment received via bKash"
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* updated order object */ },
  "previousStatus": "pending",
  "message": "Order status updated to confirmed"
}
```

### Fulfill Order (Ship)

```http
POST /api/v1/orders/:id/fulfill
Authorization: Bearer <admin_token>
```

```json
{
  "trackingNumber": "PATHAO123",
  "carrier": "Pathao",
  "notes": "Express delivery",
  "branchId": "branch_id",
  "branchSlug": "dhaka-warehouse",
  "recordCogs": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| trackingNumber | No | Shipping tracking number |
| carrier | No | Shipping carrier (e.g., Pathao, RedX) |
| notes | No | Fulfillment notes |
| shippedAt | No | Shipping date (ISO 8601) |
| estimatedDelivery | No | Estimated delivery date (ISO 8601) |
| branchId | No | Branch ID for inventory decrement (overrides order.branch) |
| branchSlug | No | Branch slug (alternative to branchId) |
| recordCogs | No | Create COGS expense transaction (default: false) |

**User-controlled COGS recording:**
- `recordCogs: false` (default) → Only decrements stock
- `recordCogs: true` → Also creates COGS expense transaction

Default is `false` because profit is already tracked in order via `costPriceAtSale` field on each item.
Use `recordCogs: true` for explicit double-entry accounting if your finance system requires a separate COGS ledger entry.

**Branch resolution priority:**
1. `branchId` or `branchSlug` from request body (admin override)
2. `order.branch` set during checkout
3. Default branch (auto-created if none exists)

**Payment rule:**
- COD (`currentPayment.method = cash`) can be fulfilled even if payment is still `pending` (cash is collected at delivery).
- Non-COD orders must have `currentPayment.status = verified` before fulfillment.

**Response:**
```json
{
  "success": true,
  "data": { /* updated order object */ },
  "cogsTransaction": {
    "_id": "txn_id",
    "amount": 50000,
    "category": "cogs"
  },
  "message": "Order fulfilled successfully"
}
```

> **Note:** `cogsTransaction` is only included when `recordCogs: true` is passed in the request. Otherwise it's `null`.

### Refund Order

```http
POST /api/v1/orders/:id/refund
Authorization: Bearer <admin_token>
```

```json
{
  "amount": 50000,
  "reason": "Product damaged"
}
```

> **Notes:**
> - Omit `amount` for full refund. Amount is in paisa.
> - **Membership Points:** If customer redeemed points during checkout, they are automatically restored to their account on refund. See [Customer API - Points Lifecycle](customer.md#points-lifecycle--restoration).

---

## Shipping Management

### Shipping Providers

Supported providers: `redx`, `pathao`, `steadfast`, `paperfly`, `sundarban`, `sa_paribahan`, `dhl`, `fedex`, `manual`, `other`

### Shipping Status Flow

```
pending → requested → picked_up → in_transit → out_for_delivery → delivered
                ↓           ↓            ↓               ↓
           cancelled    returned     returned      failed_attempt → returned
```

| Status | Description |
|--------|-------------|
| `pending` | Ready for shipping, not yet requested |
| `requested` | Pickup requested from courier |
| `picked_up` | Courier has collected the package |
| `in_transit` | Package is in transit |
| `out_for_delivery` | Package is out for delivery |
| `delivered` | Package delivered to customer |
| `failed_attempt` | Delivery attempt failed |
| `returned` | Package returned to sender |
| `cancelled` | Shipment cancelled |

### Choose Your Shipping Method

| Method | When to Use | Endpoint |
|--------|-------------|----------|
| **Manual** | You book courier yourself (phone, walk-in) and just record tracking | `POST /orders/:id/shipping` |
| **RedX API** | System automatically creates shipment via RedX | `POST /orders/:id/shipping` with `useProviderApi: true` |

---

### Manual Shipping (No API Integration)

Use this when you've already booked a courier manually and just need to record the tracking info.

```http
POST /api/v1/orders/:id/shipping
Authorization: Bearer <admin_token>
```

**Request:**
```json
{
  "provider": "manual",
  "trackingNumber": "COURIER123456",
  "trackingUrl": "https://courier-website.com/track/COURIER123456"
}
```

**Use cases:** Local couriers, self-delivery, SA Paribahan, Sundarban (no API yet)

---

### RedX API Shipping (Automated)

Use this to automatically create a shipment via RedX API. The system will:
- Create parcel in RedX dashboard
- Get tracking number automatically
- Receive webhook updates for status changes

```http
POST /api/v1/orders/:id/shipping
Authorization: Bearer <admin_token>
```

**Request:**
```json
{
  "provider": "redx",
  "useProviderApi": true,
  "pickupStoreId": 1,
  "weight": 500,
  "instructions": "Handle with care"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `provider` | Yes | Must be `redx` for API integration |
| `useProviderApi` | Yes | Set to `true` to trigger RedX API |
| `pickupStoreId` | No | Pickup store ID (get from `/logistics/pickup-stores`) |
| `weight` | No | Parcel weight in grams |
| `instructions` | No | Special handling instructions |

**Response:** Returns `trackingId`, `providerOrderId`, and full `shipping` object with `charges` and `cashCollection`.

**Requirements:**
- Payment must be verified before creating RedX shipment (except COD)
- RedX API credentials configured in environment

**Get Pickup Stores:** `GET /api/v1/logistics/pickup-stores` (Admin)

### Update Shipping Status

```http
PATCH /api/v1/orders/:id/shipping
Authorization: Bearer <admin_token>
```

```json
{
  "status": "picked_up",
  "note": "Courier picked up package",
  "metadata": {
    "pickupAgent": "Agent Name",
    "pickupPhoto": "https://..."
  }
}
```

**Auto-sync with Order Status:**
- `picked_up` → Order status becomes `shipped`
- `delivered` → Order status becomes `delivered`

### Track Shipment via Provider API

```http
GET /api/v1/logistics/shipments/:id/track
Authorization: Bearer <admin_token>
```

> `:id` can be order ID or tracking number. Returns `shipping` object + live `tracking` timeline from provider.

### Get Shipping Info

```http
GET /api/v1/orders/:id/shipping
Authorization: Bearer <token>
```

> Users can only fetch their own orders. Admins can fetch any. Returns stored `shipping` object from order.

### Cancel Shipment

```http
POST /api/v1/logistics/shipments/:id/cancel
Authorization: Bearer <admin_token>
```

```json
{
  "reason": "Customer cancelled order"
}
```

---

## Logistics Webhook Processing

Logistics providers (RedX, Pathao, etc.) send webhooks when shipment status changes. The system processes these webhooks and updates `order.shipping` directly.

### Webhook Endpoint

```http
POST /webhooks/logistics/:provider
```

> **Note:** This endpoint is provider-authenticated (signature validation) and not called by frontend.

### How Webhooks Work

```
Provider (RedX) → Webhook → Backend → Find Order by trackingNumber → Update order.shipping → Save
```

1. **Provider sends webhook** with tracking number and status update
2. **Backend parses webhook** using provider-specific adapter (e.g., `RedXProvider.parseWebhook()`)
3. **Find order** by `shipping.trackingNumber` index (fast lookup)
4. **Map provider status** to internal status (e.g., RedX `ready-for-delivery` → `picked_up`)
5. **Update order.shipping** fields:
   - `status` - Normalized shipping status
   - `providerStatus` - Raw status from provider
   - `lastWebhookAt` - Timestamp
   - `webhookCount` - Increment counter
   - `history` - Append status change entry
   - Timestamps (`pickedUpAt`, `deliveredAt`) if applicable
   - `cashCollection.collected` if COD delivered
6. **Save order** - All changes are atomic

### Provider Status Mapping

| Provider Status (RedX) | Internal Status | Order Status |
|------------------------|-----------------|--------------|
| `pickup-requested` | `requested` | - |
| `pickup-pending` | `requested` | - |
| `picked-up`, `ready-for-delivery` | `picked_up` | `shipped` |
| `in-transit`, `agent-hold` | `in_transit` | - |
| `delivery-in-progress`, `out-for-delivery` | `out_for_delivery` | - |
| `delivered` | `delivered` | `delivered` |
| `agent-returning`, `returning` | `returned` | - |
| `returned` | `returned` | - |
| `on-hold` | (no change) | - |

Webhooks update: `status`, `providerStatus`, `lastWebhookAt`, `webhookCount`, `history[]`, timestamps, and `cashCollection.collected` (if COD delivered).

---

## Error Responses

```json
{
  "success": false,
  "message": "Error description"
}
```

| Status | Common Errors |
|--------|---------------|
| 400 | Validation errors, invalid status transition |
| 403 | Access denied (not your order) |
| 404 | Order not found |
