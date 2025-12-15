# Checkout API Guide

Quick reference for implementing checkout flow with order creation.

> **Payment Gateway:** This guide covers **manual payment gateway** (default). Customers provide basic payment info (type, TrxID, sender phone). Advanced fields like `paymentDetails` are library-managed for automated gateways (Stripe, SSLCommerz, bKash API).

---

## Checkout Flow

```
1. Shopping  → Add items to cart (POST /api/v1/cart/items)
2. Location  → Customer selects delivery area (from bd-areas constants)
3. Checkout  → Fetch cart + platform config + delivery charge estimate
4. Order     → POST /api/v1/orders with delivery address (including area info) + payment info
5. Backend   → Processes cart, validates coupon, creates shipment, reserves inventory, creates order, clears cart
```

---

## Step 1: Location Selection

Before checkout, customer selects their delivery area. This determines delivery charges and logistics provider.

### Get Delivery Areas

**For Dhaka Metro (Most Common):**
```javascript
import { DHAKA_AREAS, searchAreas } from '@/constants/bd-areas';

// Show autocomplete/dropdown with Dhaka areas
const areas = DHAKA_AREAS; // Returns all Dhaka metro areas

// Or search by name
const results = searchAreas('mohammadpur'); // Fuzzy search
// Returns: [{ id: 1, name: 'Mohammadpur', postCode: '1207', zone: 'dhaka-metro', ... }]
```

**Response Format:**
```javascript
{
  id: 1,                    // Our internal area ID (save this)
  name: 'Mohammadpur',      // Display name
  postCode: '1207',         // Postal code
  zone: 'dhaka-metro',      // Pricing zone
  providers: {              // Provider-specific IDs (backend use)
    redx: 1,
    pathao: 101
  }
}
```

### Get Delivery Charge Estimate

```javascript
import { estimateDeliveryCharge } from '@/constants/bd-areas';

// Based on selected area's zone
const area = DHAKA_AREAS.find(a => a.id === 1); // Mohammadpur
const estimate = estimateDeliveryCharge(area.zone, orderTotal);

// Returns:
// {
//   deliveryCharge: 60,      // Base delivery charge
//   codCharge: 14,           // COD charge (1% of 1400)
//   totalCharge: 74          // Total delivery cost
// }
```

**⚠️ Note:** These are **estimates only**. Actual charges come from provider API at checkout (if enabled in platform config).

---

## Create Order (Checkout)

```http
POST /api/v1/orders
Authorization: Bearer <token>
```

### Request Body

```json
{
  "deliveryAddress": {
    "recipientName": "John Doe",          // Optional: For gift orders or different recipient
    "recipientPhone": "01712345678",      // Required: Contact phone for delivery
    "addressLine1": "House 12, Road 5",   // Street address
    "addressLine2": "Mohammadpur",        // Optional: Additional details
    "areaId": 1,                          // Required: From bd-areas constants
    "areaName": "Mohammadpur",            // Required: Area name
    "zoneId": 1,                          // Required: Zone ID for pricing (1-6)
    "providerAreaIds": { "redx": 1 },     // Optional: Provider-specific area IDs
    "city": "Dhaka",                      // District/City
    "division": "Dhaka",                  // Optional: Division
    "postalCode": "1207",                 // Optional: From area
    "country": "Bangladesh"               // Optional, defaults to Bangladesh
  },
  "delivery": {
    "method": "standard",                 // From platform config
    "price": 60,                          // From platform config
    "estimatedDays": 3                    // Optional
  },
  "paymentData": {
    "type": "bkash",                      // cash | bkash | nagad | rocket | bank | card
    "reference": "BGH3K5L90P",           // Transaction ID (TrxID) from payment
    "senderPhone": "01712345678"         // Required for mobile wallets (bkash/nagad/rocket)
  },
  "isGift": true,                         // Optional: true if ordering for someone else
  "couponCode": "SAVE10",                 // Optional: discount coupon
  "notes": "Leave at door"                // Optional: order notes
}
```

### Required Fields

| Field | Required | Notes |
|-------|----------|-------|
| `deliveryAddress.recipientPhone` | ✅ Yes | Contact phone for delivery (01XXXXXXXXX) |
| `deliveryAddress.addressLine1` | ✅ Yes | Street address |
| `deliveryAddress.areaId` | ✅ Yes | Area ID from bd-areas constants |
| `deliveryAddress.areaName` | ✅ Yes | Area name (e.g., "Mohammadpur") |
| `deliveryAddress.zoneId` | ✅ Yes | Zone ID for pricing (1-6) |
| `deliveryAddress.city` | ✅ Yes | City/District name |
| `delivery.method` | ✅ Yes | Delivery method from platform config |
| `delivery.price` | ✅ Yes | Delivery price from platform config or area estimate |
| `paymentData.type` | ✅ Yes | cash, bkash, nagad, rocket, bank, card |
| `paymentData.reference` | ⚠️ Recommended | Transaction ID (helps admin verify) |
| `paymentData.senderPhone` | ⚠️ Required for wallets | For bkash/nagad/rocket (01XXXXXXXXX) |

### Response

```json
{
  "success": true,
  "data": {
    "_id": "order_id",
    "customer": "customer_id",
    "customerName": "Jane Smith",         // Buyer's name (snapshot)
    "customerPhone": "01787654321",       // Buyer's phone (snapshot)
    "customerEmail": "jane@example.com",  // Buyer's email (snapshot)
    "userId": "user_id",                  // Link to user account
    "items": [...],
    "subtotal": 1500,
    "discountAmount": 150,
    "totalAmount": 1410,
    "delivery": {
      "method": "standard",
      "price": 60
    },
    "deliveryAddress": {
      "recipientName": "John Doe",        // Gift recipient
      "addressLine1": "123 Main St",
      "city": "Dhaka",
      "phone": "01712345678"
    },
    "isGift": true,                       // This is a gift order
    "status": "pending",
    "currentPayment": {
      "transactionId": "txn_id",
      "amount": 141000,                   // In paisa (multiply by 100)
      "status": "pending",
      "method": "bkash",
      "reference": "BGH3K5L90P"
    },
    "couponApplied": {
      "code": "SAVE10",
      "discountType": "percentage",
      "discountValue": 10,
      "discountAmount": 150
    },
    "createdAt": "2025-12-08T10:00:00.000Z",
    "updatedAt": "2025-12-08T10:00:00.000Z"
  },
  "transaction": "txn_id",
  "message": "Order created successfully"
}
```

---

## New Features

### 🎁 Gift Orders

When `isGift: true`, use `deliveryAddress.recipientName` for the gift recipient:

```json
{
  "deliveryAddress": {
    "recipientName": "John Doe",     // Gift recipient's name
    "addressLine1": "123 Main St",
    "city": "Dhaka",
    "phone": "01712345678"           // Gift recipient's phone
  },
  "isGift": true,
  "notes": "Birthday gift - please include greeting card"
}
```

**Order stores both:**
- `customerName`, `customerPhone`, `customerEmail` → Buyer (who placed order)
- `deliveryAddress.recipientName` → Gift recipient (where to deliver)

### 📦 Customer Snapshot

Orders now store customer data at order time (no populate needed):
- `customerName` - Buyer's name
- `customerPhone` - Buyer's phone
- `customerEmail` - Buyer's email
- `userId` - Link to user account (if logged in)

This means you can display order history without extra queries!

---

## Step 2: Load Checkout Data

Before showing checkout page, fetch cart and platform config:

```javascript
// 1. Get cart items
const cartRes = await fetch('/api/v1/cart', {
  headers: { Authorization: `Bearer ${token}` }
});
const { data: cart } = await cartRes.json();

// 2. Get platform config (delivery + payment options)
const configRes = await fetch('/api/v1/platform/config?select=payment,deliveryOptions');
const { data: config } = await configRes.json();

// 3. Extract data for checkout UI
const deliveryOptions = config.deliveryOptions.filter(opt => opt.isActive);

// 4. Payment methods available
const paymentMethods = [];
if (config.payment.cash?.enabled) {
  paymentMethods.push({ type: 'cash', label: 'Cash on Delivery' });
}
if (config.payment.bkash?.walletNumber) {
  paymentMethods.push({
    type: 'bkash',
    label: 'bKash',
    merchantNumber: config.payment.bkash.walletNumber,
    merchantName: config.payment.bkash.walletName
  });
}
if (config.payment.nagad?.walletNumber) {
  paymentMethods.push({
    type: 'nagad',
    label: 'Nagad',
    merchantNumber: config.payment.nagad.walletNumber,
    merchantName: config.payment.nagad.walletName
  });
}
if (config.payment.bank?.accountNumber) {
  paymentMethods.push({
    type: 'bank',
    label: 'Bank Transfer',
    bankName: config.payment.bank.bankName,
    accountNumber: config.payment.bank.accountNumber,
    accountName: config.payment.bank.accountName
  });
}
```

---

## Examples

### Example 1: Cash on Delivery (COD)

Simplest checkout - customer pays on delivery.

```json
{
  "deliveryAddress": {
    "recipientPhone": "01712345678",
    "addressLine1": "House 45, Road 12",
    "areaId": 2,
    "areaName": "Dhanmondi",
    "zoneId": 1,
    "city": "Dhaka",
    "postalCode": "1209"
  },
  "delivery": {
    "method": "standard",
    "price": 60
  },
  "paymentData": {
    "type": "cash"
  }
}
```

### Example 2: bKash Payment (Manual)

Customer pays to merchant's bKash first, then provides TrxID.

**Step 1:** Get merchant's bKash number from platform config:
```javascript
const config = await fetch('/api/v1/platform/config?select=payment');
const merchantBkash = config.data.payment.bkash.walletNumber; // "01712345678"
```

**Step 2:** Customer sends money to merchant's bKash and gets TrxID: `BGH3K5L90P`

**Step 3:** Submit order with TrxID:
```json
{
  "deliveryAddress": {
    "recipientPhone": "01712345678",
    "addressLine1": "House 45, Road 12",
    "areaId": 2,
    "areaName": "Dhanmondi",
    "zoneId": 1,
    "city": "Dhaka",
    "postalCode": "1209"
  },
  "delivery": {
    "method": "express",
    "price": 80
  },
  "paymentData": {
    "type": "bkash",
    "reference": "BGH3K5L90P",           // TrxID from bKash
    "senderPhone": "01712345678"         // Customer's bKash number
  },
  "couponCode": "SAVE10"
}
```

### Example 3: Bank Transfer

Customer transfers to merchant's bank account.

```json
{
  "deliveryAddress": {
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
    "type": "bank",
    "reference": "FT2025120812345"
  }
}
```

### Example 4: Gift Order

Ordering on behalf of someone else (different recipient).

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
    "senderPhone": "01712345678"         // Buyer's phone (payer)
  },
  "isGift": true,
  "notes": "Birthday gift - please include greeting card"
}
```

---

## Step 3: Frontend Validation

```javascript
function validateCheckout(address, delivery, paymentData) {
  // Required fields
  if (!address?.recipientPhone || !address?.addressLine1 || !address?.areaId || !address?.areaName || !address?.zoneId || !address?.city) {
    return 'Please provide complete delivery address with area selection';
  }
  if (!delivery?.method || delivery?.price === undefined) {
    return 'Please select a delivery method';
  }
  if (!paymentData?.type) {
    return 'Please select payment method';
  }

  // Phone validation
  const phoneRegex = /^01[0-9]{9}$/;
  if (!phoneRegex.test(address.recipientPhone)) {
    return 'Invalid phone number (use format: 01XXXXXXXXX)';
  }

  // Mobile wallet validation
  const walletMethods = ['bkash', 'nagad', 'rocket'];
  if (walletMethods.includes(paymentData.type)) {
    if (!paymentData.senderPhone || !phoneRegex.test(paymentData.senderPhone)) {
      return 'Please enter valid sender phone for mobile wallet';
    }
  }

  return null; // Valid
}
```

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
| 400 | Validation errors, insufficient stock, invalid coupon |
| 401 | Not authenticated |
| 404 | Cart is empty |
| 500 | Server error |

---

## Payment Flow

All payments use **manual gateway** by default. The `paymentData` object only needs basic info from customers.

> **Note:** Advanced fields like `paymentDetails`, `gateway`, etc. are **library-managed** for automated payment gateways (Stripe, SSLCommerz, bKash API). Don't send these for manual payments.

### Option 1: Pay First (Mobile Wallets/Bank)

**Best for: bKash, Nagad, Rocket, Bank Transfer**

1. **Get merchant payment info** from platform config:
   ```javascript
   const config = await fetch('/api/v1/platform/config?select=payment');
   // Show merchant's bkash.walletNumber, bank.accountNumber, etc.
   ```

2. **Customer pays** to merchant's account and gets TrxID/reference

3. **Checkout form collects:**
   - Delivery address
   - Selected delivery method
   - Payment type + TrxID + sender phone

4. **Submit order** → Backend creates order with `status: pending`, `paymentStatus: pending`

5. **Admin verifies** payment in merchant panel → Order becomes `confirmed`

### Option 2: Cash on Delivery (COD)

**Best for: Local deliveries**

1. Customer selects "Cash" as payment method
2. Submit order → `status: pending`, `paymentStatus: pending`
3. Delivery person collects cash on delivery
4. Admin marks payment as verified → Order becomes `confirmed`

---

## Next Steps

After successful order creation:

1. **Clear local cart state** (backend clears cart automatically)
2. **Redirect to order confirmation page** with order ID
3. **Show order details** and payment instructions (if pending)
4. **Poll order status** every 30s: `GET /api/v1/orders/my/:id`

---

## TypeScript Types

```typescript
interface CreateOrderPayload {
  deliveryAddress: {
    recipientName?: string;           // For gift orders
    recipientPhone: string;           // Contact phone for delivery
    addressLine1: string;
    addressLine2?: string;
    areaId: number;                   // From bd-areas constants
    areaName: string;                 // Area display name
    zoneId: number;                   // Zone ID for pricing (1-6)
    providerAreaIds?: {               // Provider-specific area IDs
      redx?: number;
      pathao?: number;
    };
    city: string;                     // District/City
    division?: string;                // Division
    postalCode?: string;              // Postal code
    country?: string;                 // Default: Bangladesh
  };
  delivery: {
    method: string;
    price: number;
    estimatedDays?: number;
  };
  paymentData?: {
    type: 'cash' | 'bkash' | 'nagad' | 'rocket' | 'bank' | 'card';
    reference?: string;               // Transaction ID (TrxID)
    senderPhone?: string;             // Required for mobile wallets
    // Note: gateway, paymentDetails are library-managed, don't send from FE
  };
  isGift?: boolean;                   // Gift order flag
  couponCode?: string;
  notes?: string;
}
```

Full types available at: `docs/.fe/types/order.types.ts`
