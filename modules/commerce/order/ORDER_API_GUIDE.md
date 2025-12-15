# Order API Integration Guide

Quick reference for frontend integration with the Order API.

> **🚀 Quick Start:** For checkout implementation, see [CHECKOUT_API_GUIDE.md](./CHECKOUT_API_GUIDE.md)

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | User | Create order (checkout from cart) |
| `GET` | `/api/orders/my` | User | List my orders |
| `GET` | `/api/orders/my/:id` | User | Get my order detail |
| `POST` | `/api/orders/:id/cancel` | User/Admin | Cancel order (owner or admin) |
| `POST` | `/api/orders/:id/cancel-request` | User/Admin | Request cancellation (await admin review) |
| `GET` | `/api/orders/:id` | User/Admin | Get order by ID |
| `PATCH` | `/api/orders/:id` | Admin | Update order (admin CRUD) |
| `DELETE` | `/api/orders/:id` | Admin | Delete order (admin CRUD) |
| `GET` | `/api/orders` | Admin | List all orders |
| `PATCH` | `/api/orders/:id/status` | Admin | Update order status |
| `POST` | `/api/orders/:id/fulfill` | Admin | Ship order |
| `POST` | `/api/orders/:id/refund` | Admin | Refund order |
| `POST` | `/api/orders/:id/shipping` | Admin | Record shipping info (manual) |
| `PATCH` | `/api/orders/:id/shipping` | Admin | Update shipping status |
| `GET` | `/api/orders/:id/shipping` | User/Admin | Get shipping info |
| `POST` | `/webhooks/payments/manual/verify` | Superadmin | Verify manual payment (bkash/nagad/bank/cash) |
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
3. Order     → POST /api/orders with delivery + payment info
4. Backend   → Processes cart, validates coupon, reserves inventory, creates order, clears cart
```

### Frontend Checkout Flow

```javascript
// 1. Load checkout data
const [cartRes, configRes] = await Promise.all([
  fetch('/api/v1/cart', { headers: { Authorization: `Bearer ${token}` } }),
  fetch('/api/v1/platform/config?select=payment,deliveryOptions')
]);

const { data: cart } = await cartRes.json();
const { data: config } = await configRes.json();

// 2. Display cart items, delivery options, payment methods
const deliveryOptions = config.deliveryOptions.filter(opt => opt.isActive);

// 3. User enters/selects delivery address, delivery method, payment info

// 4. Submit order payload
const orderPayload = {
  deliveryAddress: {
    addressLine1: '123 Main St',
    city: 'Dhaka',
    phone: '01712345678',
    // ... other address fields
  },
  delivery: {
    method: selectedDeliveryOption.name,
    price: selectedDeliveryOption.price
  },
  couponCode: appliedCoupon?.code || null,
  paymentData: {
    type: 'bkash', // 'cash', 'bkash', 'nagad', 'rocket', 'bank'
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

> **Backend handles:** Cart fetch (only source for products), coupon validation, price calculation, inventory reservation, transaction creation, cart clearing.

---

## Customer Endpoints

### Create Order (Checkout)

```http
POST /api/orders
Authorization: Bearer <token>
```

**Checkout page data sources:**
- **Cart:** `GET /api/v1/cart` → display cart items (read-only for FE)
- **Config:** `GET /api/v1/platform/config?select=payment,deliveryOptions` → delivery methods + payment options

**Backend automatically:**
- Fetches cart items (only source for products)
- Calculates pricing with variation modifiers
- Validates coupon and applies discount
- Reserves inventory atomically
- Creates order + transaction
- Clears cart on success

#### Example 1: Cash on Delivery (COD)

**Request:**
```json
{
  "deliveryAddress": {
    "addressLine1": "123 Main St",
    "city": "Dhaka",
    "phone": "01712345678"
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

#### Example 3: Gift Order (with Recipient Name)

**Request:**
```json
{
  "deliveryAddress": {
    "recipientName": "John Doe",
    "addressLine1": "456 Park Ave",
    "city": "Chittagong",
    "phone": "01798765432"
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

#### Example 2: bKash Payment (Manual Gateway)

**Request:**
```json
{
  "deliveryAddress": {
    "addressLine1": "123 Main St",
    "city": "Dhaka",
    "phone": "01712345678"
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
  "couponCode": "SAVE10",
  "notes": "Leave at door"
}
```

#### Request Body Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deliveryAddress` | object | Yes | Delivery address details |
| `deliveryAddress.recipientName` | string | No | Recipient name (for gift orders or ordering on behalf of someone) |
| `deliveryAddress.addressLine1` | string | Yes | Street address |
| `deliveryAddress.city` | string | Yes | City name |
| `deliveryAddress.phone` | string | Yes | Contact phone (`01XXXXXXXXX`) |
| `deliveryAddress.addressLine2` | string | No | Additional address info |
| `deliveryAddress.state` | string | No | State/province |
| `deliveryAddress.postalCode` | string | No | Postal code |
| `delivery` | object | Yes | Delivery method and pricing |
| `delivery.method` | string | Yes | Delivery method name (from platform config) |
| `delivery.price` | number | Yes | Delivery price in BDT (from platform config) |
| `isGift` | boolean | No | True if ordering on behalf of someone else (use `recipientName` in `deliveryAddress`) |
| `couponCode` | string | No | Coupon code for discount (validated by backend) |
| `notes` | string | No | Order notes |
| `paymentData` | object | Yes | Payment information (for manual gateway) |
| `paymentData.type` | string | Yes | Payment type: `cash`, `bkash`, `nagad`, `rocket`, `bank` |
| `paymentData.reference` | string | No | Customer's payment TrxID (recommended for verification) |
| `paymentData.senderPhone` | string | Yes (wallets) | Sender phone for mobile wallet payments (`01XXXXXXXXX`) |

> **Notes:**
> - **Manual Gateway:** Frontend only needs to send `type`, `reference`, and `senderPhone`. Advanced fields like `paymentDetails`, `gateway` are library-managed for automated gateways (Stripe, SSLCommerz, bKash API)
> - Cart items are fetched automatically by backend (only source for products)
> - Backend calculates all prices (product + variations + delivery - coupon)
> - FE passes delivery method + price from platform config
> - Cart is cleared automatically after successful order

---

## Manual Payment Verification (Admin)

Mounted without `/api` prefix (registered at `/webhooks/payments` in `app.js`).

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

#### Response

**Response:**
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
    "totalAmount": 1560,
    "items": [...]
  },
  "transaction": "txn_id",
  "message": "Order created successfully"
}
```

---

### Get My Orders

```http
GET /api/orders/my?page=1&limit=10&status=pending
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
GET /api/orders/my/:id
Authorization: Bearer <token>
```

---

### Cancel Order

```http
POST /api/orders/:id/cancel
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
POST /api/orders/:id/cancel-request
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
PATCH /api/orders/:id
Authorization: Bearer <admin_token>
```

Use for administrative field updates supported by the model (e.g., metadata). For status changes prefer the dedicated `/status` endpoint.

---

### Delete Order (Admin CRUD)

```http
DELETE /api/orders/:id
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

---

## Key Response Fields

```typescript
interface Order {
  _id: string;
  customer: string;
  customerName: string;           // Snapshot: Buyer's name at order time
  customerPhone?: string;         // Snapshot: Buyer's phone
  customerEmail?: string;         // Snapshot: Buyer's email
  userId?: string;                // Link to user account (if logged in)
  status: 'pending' | 'processing' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

  // Payment info
  currentPayment: {
    transactionId: string;
    amount: number;        // In paisa (smallest unit)
    status: 'pending' | 'verified' | 'failed' | 'refunded';
    method: string;
    reference?: string;    // Customer's payment TrxID (e.g., bKash: BGH3K5L90P)
    verifiedAt?: Date;
    verifiedBy?: string;
  };

  // Totals (in BDT)
  subtotal: number;
  discountAmount: number;
  totalAmount: number;

  // Items
  items: Array<{
    product: string;
    productName: string;
    quantity: number;
    price: number;
    variations?: Array<{ name: string; option: { value: string } }>;
  }>;

  // Delivery
  delivery: { method: string; price: number };
  deliveryAddress: {
    recipientName?: string;       // Gift recipient (if isGift: true)
    addressLine1: string;
    city: string;
    phone: string;
  };
  isGift: boolean;                // True if ordering on behalf of someone

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
GET /api/orders?page=1&limit=20&status=pending
Authorization: Bearer <admin_token>
```

### Update Order Status

```http
PATCH /api/orders/:id/status
Authorization: Bearer <admin_token>
```

```json
{
  "status": "confirmed",
  "note": "Payment received via bKash"
}
```

### Fulfill Order (Ship)

```http
POST /api/orders/:id/fulfill
Authorization: Bearer <admin_token>
```

```json
{
  "trackingNumber": "PATHAO123",
  "carrier": "Pathao",
  "notes": "Express delivery"
}
```

### Refund Order

```http
POST /api/orders/:id/refund
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
POST /api/orders/:id/shipping
Authorization: Bearer <admin_token>
```

```json
{
  "provider": "redx",
  "trackingNumber": "REDX123456789",
  "trackingUrl": "https://track.redx.com.bd/REDX123456789"
}
```

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
PATCH /api/orders/:id/shipping
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
GET /api/orders/:id/shipping
Authorization: Bearer <token>
```

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
| `POST` | `/webhooks/payments/manual/verify` | Superadmin | Manual verification for cash/mobile/bank payments |

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
    "transactionId": "...",
    "status": "verified",
    "verifiedAt": "2025-01-12T10:00:00.000Z"
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
2. **Amount conversion:** API uses paisa (×100). Display: `amount / 100` BDT
3. **Polling for status:** Poll `/my/:id` every 30s on order confirmation page
4. **Cancellation:** Disable cancel button when `status !== 'pending'`
5. **Payment pending:** Show payment instructions when `currentPayment.status === 'pending'`
6. **Gift orders:** Set `isGift: true` and use `deliveryAddress.recipientName` for gift recipient
7. **Customer data:** Orders now include `customerName`, `customerPhone`, `customerEmail` (no populate needed)

### Checkout Page Setup

```javascript

// Build order payload
function buildOrderPayload(address, deliveryOption, paymentInfo, couponCode, notes) {
  return {
    deliveryAddress: {
      addressLine1: address.addressLine1,
      city: address.city,
      phone: address.phone,
      addressLine2: address.addressLine2,
      state: address.state,
      postalCode: address.postalCode
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
2. At checkout, show payment instructions (from `config.payment.bkash.walletNumber`, etc.)
3. Customer pays via bKash/Nagad and gets TrxID
4. Checkout form collects:
   - Delivery address
   - Selected delivery method (name + price)
   - Payment type + TrxID + sender phone
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
  if (!address?.addressLine1 || !address?.city || !address?.phone) {
    return 'Please provide complete delivery address';
  }
  if (!delivery?.method || delivery?.price === undefined) {
    return 'Please select a delivery method';
  }
  if (!paymentData?.type) {
    return 'Please select payment method';
  }
  
  const { type, senderPhone } = paymentData;
  if (['bkash', 'nagad', 'rocket'].includes(type)) {
    if (!senderPhone || !/^01[0-9]{9}$/.test(senderPhone)) {
      return 'Please enter valid phone number (01XXXXXXXXX)';
    }
  }
  
  return null; // Valid
};
```

