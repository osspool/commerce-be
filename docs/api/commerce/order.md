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
| `POST` | `/api/v1/orders/:id/shipping` | Admin | Record shipping info (manual) |
| `PATCH` | `/api/v1/orders/:id/shipping` | Admin | Update shipping status |
| `GET` | `/api/v1/orders/:id/shipping` | User/Admin | Get shipping info |
| `POST` | `/webhooks/payments/manual/verify` | Superadmin | Verify manual payment (bkash/nagad/bank_transfer/cash) |
| `POST` | `/webhooks/payments/manual/reject` | Superadmin | Reject manual payment (invalid/fraud) |

**Logistics API (RedX Integration)**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/logistics/pickup-stores` | Admin | List pickup stores from RedX |
| `POST` | `/api/v1/logistics/shipments` | Admin | Create shipment via RedX API |
| `GET` | `/api/v1/logistics/shipments/:id` | Admin | Get shipment details |
| `GET` | `/api/v1/logistics/shipments/:id/track` | Admin | Track shipment via RedX API |
| `POST` | `/api/v1/logistics/shipments/:id/cancel` | Admin | Cancel shipment |
| `GET` | `/api/v1/logistics/charge` | Public | Calculate delivery charge |

---

## Checkout Flow (Cart → Order)

**Simple flow:** FE sends delivery/payment/coupon, BE fetches cart items only.

```
1. Shopping  → Add items to cart (POST /api/v1/cart/items)
2. Checkout  → Fetch cart + platform config
3. Order     → POST /api/v1/orders with delivery + payment info
4. Backend   → Processes cart, validates coupon, reserves stock (temporary), creates order, clears cart
```

> **Stock behavior (web checkout):** Stock is **reserved** at checkout (in `StockEntry.reservedQuantity`) to prevent oversells, then **committed/decremented** when an admin fulfills the order. Reservations auto-expire if not fulfilled.

### Frontend Checkout Flow

```javascript
// 1. Load checkout data
const [cartRes, configRes] = await Promise.all([
  fetch('/api/v1/cart', { headers: { Authorization: `Bearer ${token}` } }),
  fetch('/api/v1/platform/config?select=paymentMethods,checkout')
]);

const { data: cart } = await cartRes.json();
const { data: config } = await configRes.json();

// 2. Display cart items, delivery zones, payment methods
// Delivery pricing is provided by logistics estimate API
const activePayments = config.paymentMethods.filter(pm => pm.isActive !== false);

// Group payments by type for UI
const mfsPayments = activePayments.filter(pm => pm.type === 'mfs');  // bKash, Nagad, Rocket
const bankPayments = activePayments.filter(pm => pm.type === 'bank_transfer');

// 3. User enters/selects delivery address, delivery method, payment info

// 4. Submit order payload
// NOTE: For MFS payments, use 'provider' as paymentData.type (e.g., 'bkash', not 'mfs')
const orderPayload = {
  idempotencyKey: crypto.randomUUID(), // Optional: prevents duplicate orders on retry
  deliveryAddress: {
    addressLine1: '123 Main St',
    city: 'Dhaka',
    phone: '01712345678',
    // ... other address fields
  },
  delivery: {
    method: selectedDeliveryZone.name,
    price: selectedDeliveryZone.price
  },
  couponCode: appliedCoupon?.code || null,
  paymentData: {
    type: 'bkash', // 'cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card'
    reference: trxId, // Optional
    senderPhone: '01712345678', // Required for wallets
    paymentDetails: { ... } // Optional
  },
  notes: 'Leave at door' // Optional
};

// 5. Place order → backend fetches cart, validates coupon, reserves inventory, creates order, clears cart
const orderRes = await fetch('/api/v1/orders', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(orderPayload)
});
```

> **Backend handles:** Cart fetch (only source for products), coupon validation, price calculation, stock reservation, transaction creation, cart clearing.

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
- [Product API - VAT Rate Configuration](product.md#vat-rate-configuration) - Set product/variant-level rates
- [Category API - VAT Rate Configuration](category.md#vat-rate-configuration) - Set category-level rates
- [Platform API - VAT Configuration](platform.md) - Configure platform-wide VAT settings

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

#### Example 1: Cash on Delivery (COD)

**Request:**
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
  "delivery": {
    "method": "standard",
    "price": 60
  },
  "paymentData": {
    "type": "cash"
  },
  "couponCode": "SAVE10",
  "notes": "Leave at door"
}
```

#### Example 2: bKash Payment (Manual Gateway)

**Request:**
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
  "delivery": {
    "method": "express",
    "price": 120
  },
  "paymentData": {
    "type": "bkash",
    "reference": "BGH3K5L90P",
    "senderPhone": "01712345678"
  },
  "couponCode": "SAVE10"
}
```

#### Example 3: Gift Order (with Recipient Name)

**Request:**
```json
{
  "deliveryAddress": {
    "recipientName": "John Doe",
    "recipientPhone": "01798765432",
    "addressLine1": "House 23, CDA Avenue",
    "areaId": 150,
    "areaName": "Agrabad",
    "zoneId": 3,
    "city": "Chittagong"
  },
  "delivery": {
    "method": "express",
    "price": 120
  },
  "paymentData": {
    "type": "bkash",
    "reference": "BGH3K5L90P",
    "senderPhone": "01712345678"
  },
  "isGift": true,
  "notes": "Birthday gift - please include greeting card"
}
```

> **Note:** For complete delivery address structure with Bangladesh location selection, see [Checkout API](checkout.md#step-1-location-selection)

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

Mounted outside `/api/v1` (registered at `/webhooks/payments` in `app.js`).

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
    amount: number;        // In BDT
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

  // Shipping (courier integration)
  shipping?: {
    provider: string;
    status: 'pending' | 'requested' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'failed_attempt' | 'returned' | 'cancelled';
    trackingNumber?: string;
    trackingUrl?: string;
    consignmentId?: string;
    estimatedDelivery?: Date;
    requestedAt?: Date;
    pickedUpAt?: Date;
    deliveredAt?: Date;
    metadata?: object;
    history: Array<{ status: string; note: string; timestamp: Date }>;
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

> Omit `amount` for full refund. Amount is in paisa.

---

## Shipping Management

### Shipping Providers

Supported providers: `redx`, `pathao`, `steadfast`, `paperfly`, `sundarban`, `sa_paribahan`, `dhl`, `fedex`, `other`

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

### Option 1: Manual Entry (Default)

Record tracking info without calling provider API:

```http
POST /api/v1/orders/:id/shipping
Authorization: Bearer <admin_token>
```

**Request:**
```json
{
  "provider": "redx",
  "trackingNumber": "REDX123456789",
  "trackingUrl": "https://track.redx.com.bd/REDX123456789"
}
```

**Response:**
```json
{
  "success": true,
  "data": { /* shipping object */ },
  "message": "Shipping requested via redx"
}
```

### Option 1b: Create Shipment via Provider API (Inline)

Alternatively, use the `useProviderApi` flag to create a shipment via the logistics provider API directly:

```http
POST /api/v1/orders/:id/shipping
Authorization: Bearer <admin_token>
```

**Request:**
```json
{
  "provider": "redx",
  "useProviderApi": true,
  "weight": 500,
  "instructions": "Handle with care"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "shipping": { /* order.shipping object */ },
    "shipment": {
      "_id": "shipment_id",
      "trackingId": "21A427TU4BN3R",
      "provider": "redx",
      "status": "pending"
    }
  },
  "message": "Shipment created via redx API"
}
```

> **Note:** When `useProviderApi: true`, payment must be verified before shipping can be requested.

### Option 2: Create Shipment via Logistics API (RedX)

For automated shipment creation via RedX API:

**Step 1: Get pickup stores (from RedX dashboard)**
```http
GET /api/v1/logistics/pickup-stores
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Main Warehouse",
      "address": "123 Main St, Mohammadpur",
      "areaId": 1,
      "areaName": "Mohammadpur(Dhaka)",
      "phone": "01712345678"
    }
  ]
}
```

**Step 2: Create shipment with selected pickup store**
```http
POST /api/v1/logistics/shipments
Authorization: Bearer <admin_token>
```

```json
{
  "orderId": "order_id",
  "pickupStoreId": 1,
  "weight": 500,
  "instructions": "Handle with care"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "shipment_id",
    "trackingId": "21A427TU4BN3R",
    "provider": "redx",
    "status": "pending",
    "order": "order_id"
  },
  "message": "Shipment created successfully"
}
```

> **Note:** This automatically updates `order.shipping` with tracking info.

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

**Response:**
```json
{
  "success": true,
  "data": {
    "shipment": { ... },
    "tracking": {
      "trackingId": "21A427TU4BN3R",
      "status": "in-transit",
      "timeline": [
        { "message_en": "Package is created", "time": "2025-12-10T10:00:00Z" },
        { "message_en": "Package is picked up", "time": "2025-12-10T14:00:00Z" }
      ]
    }
  }
}
```

### Get Shipping Info

```http
GET /api/v1/orders/:id/shipping
Authorization: Bearer <token>
```

**Access rule:**
- Regular users can only fetch shipping info for **their own** orders
- Admins can fetch shipping info for any order

**Response:**
```json
{
  "success": true,
  "data": {
    "provider": "redx",
    "status": "in_transit",
    "trackingNumber": "21A427TU4BN3R",
    "trackingUrl": "https://track.redx.com.bd/21A427TU4BN3R",
    "shipmentId": "shipment_id",
    "estimatedDelivery": "2025-12-15T00:00:00.000Z",
    "requestedAt": "2025-12-10T10:00:00.000Z",
    "pickedUpAt": "2025-12-10T14:00:00.000Z",
    "history": [
      { "status": "requested", "note": "Shipment created via RedX API", "timestamp": "..." },
      { "status": "picked_up", "note": "Courier picked up package", "timestamp": "..." }
    ]
  }
}
```

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

## Payment Verification Workflow

### Payment Webhook Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/webhooks/payments/:provider` | Provider-signed | Automatic provider webhook (Stripe, SSLCommerz, bKash, Nagad; extensible) |
| `POST` | `/webhooks/payments/manual/verify` | Superadmin | Manual verification for cash/mobile/bank-transfer payments |

> Automatic provider webhooks are signature-validated by the payment library and update transactions/orders based on events (`payment.succeeded`, `payment.failed`, `refund.succeeded`, etc.). Keep `transaction.referenceModel` / `referenceId` and `metadata.senderPhone` fields populated for future online providers.

### Manual Payment Verification (Admin)

When customers pay via bKash/Nagad/etc or when COD payment is collected, admin verifies:

**Step 1: Admin views order and sees customer's payment details:**
- `order.currentPayment.reference` → Customer's TrxID (if provided)
- `transaction.metadata.senderPhone` → Customer's phone number
- `transaction.metadata.paymentReference` → Duplicate for quick lookup

**Step 2: Admin verifies payment in provider panel (e.g., bKash merchant):**
- Search by TrxID or sender phone
- Confirm amount matches order total
- Verify payment status in provider dashboard

**Step 3: Admin calls verification endpoint:**

```http
POST /webhooks/payments/manual/verify
Authorization: Bearer <superadmin_token>
Content-Type: application/json
```

```json
{
  "transactionId": "txn_id_from_order",
  "notes": "Verified in bKash - TrxID: BGH3K5L90P, Sender: 01712345678"
}
```

**Request body:**
- `transactionId` (required) — Transaction to verify
- `notes` (optional) — Verification notes (stored in metadata)

**Response:**
```json
{
  "success": true,
  "message": "Payment verified successfully",
  "data": {
    "transactionId": "txn_id",
    "status": "verified",
    "amount": 156000,
    "category": "sales",
    "verifiedAt": "2025-01-12T10:00:00.000Z",
    "verifiedBy": "admin_user_id",
    "entity": {
      "referenceModel": "Order",
      "referenceId": "order_id"
    }
  }
}
```

**What happens after verification:**
- `order.currentPayment.status` → `verified`
- `order.status` → `confirmed`
- Timeline event added
- Customer receives confirmation email/notification

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

---

## Frontend Tips

### General

1. **Cart-first checkout:** Always use cart as source of items; cart auto-clears on order success
2. **Amounts in BDT:** Order amounts (`totalAmount`, `subtotal`, `deliveryCharge`) are in BDT. No conversion needed.
3. **VAT calculation:** Backend auto-calculates VAT from product/category/platform cascade - frontend just displays `order.vat.amount`
4. **Polling for status:** Poll `/my/:id` every 30s on order confirmation page
5. **Cancellation:** Allow cancel when `status` is not `cancelled` or `delivered` (backend allows cancellation from `pending`, `processing`, `confirmed`)
6. **Payment pending:** Show payment instructions when `currentPayment.status === 'pending'`
7. **Gift orders:** Set `isGift: true` and use `deliveryAddress.recipientName` for gift recipient
8. **Customer data:** Orders now include `customerName`, `customerPhone`, `customerEmail` (no populate needed)
9. **VAT invoice:** Display `order.vat.invoiceNumber` when available (issued at checkout or fulfillment)

### Checkout Page Setup

```javascript
// Build order payload (all required fields per schema)
function buildOrderPayload(address, deliveryOption, paymentInfo, couponCode, notes) {
  return {
    deliveryAddress: {
      // Required fields
      recipientName: address.recipientName,
      recipientPhone: address.recipientPhone,
      addressLine1: address.addressLine1,
      areaId: address.areaId,       // From bd-areas
      areaName: address.areaName,   // From bd-areas
      zoneId: address.zoneId,       // From bd-areas (1-6)
      city: address.city,
      // Optional fields
      addressLine2: address.addressLine2,
      division: address.division,
      postalCode: address.postalCode,
      providerAreaIds: address.providerAreaIds,
    },
    delivery: {
      method: deliveryOption.name,
      price: deliveryOption.price
    },
    paymentData: {
      type: paymentInfo.type,
      reference: paymentInfo.trxId,
      senderPhone: paymentInfo.phone,
      paymentDetails: paymentInfo.details
    },
    couponCode,
    notes
  };
}
```

### Payment Flow

**Option 1: Pay-first (Recommended for mobile wallets)**
1. Customer adds items to cart during shopping
2. At checkout, show payment methods (from `config.paymentMethods` array filtered by type: `mfs`)
   - Each MFS method has: `provider`, `walletNumber`, `walletName`
3. Customer pays via bKash/Nagad and gets TrxID
4. Checkout form collects:
   - Delivery address
   - Selected delivery zone (name + price)
   - Payment type (use `provider` value, e.g., 'bkash') + TrxID + sender phone
5. Submit payload → backend processes cart, validates, creates order

**Option 2: Order-first (COD)**
1. Customer adds items to cart
2. At checkout, enter address, select delivery method, choose `paymentData.type: "cash"`
3. Submit payload → backend processes cart, creates order, clears cart
4. Order created with `status: pending`, `paymentStatus: pending`
5. Customer pays on delivery, admin verifies

### Frontend Validation

```javascript
// Validate before submitting
const validateCheckout = (address, delivery, paymentData) => {
  // Required address fields (per schema)
  if (!address?.recipientName || !address?.recipientPhone) {
    return 'Please provide recipient name and phone';
  }
  if (!address?.addressLine1 || !address?.city) {
    return 'Please provide complete delivery address';
  }
  if (!address?.areaId || !address?.areaName || !address?.zoneId) {
    return 'Please select a valid delivery area';
  }
  if (!delivery?.method || delivery?.price === undefined) {
    return 'Please select a delivery method';
  }
  if (!paymentData?.type) {
    return 'Please select payment method';
  }

  // Phone validation
  if (!/^01[0-9]{9}$/.test(address.recipientPhone)) {
    return 'Please enter valid recipient phone number (01XXXXXXXXX)';
  }

  const { type, senderPhone } = paymentData;
  if (['bkash', 'nagad', 'rocket'].includes(type)) {
    if (!senderPhone || !/^01[0-9]{9}$/.test(senderPhone)) {
      return 'Please enter valid sender phone number (01XXXXXXXXX)';
    }
  }

  return null; // Valid
};
```

