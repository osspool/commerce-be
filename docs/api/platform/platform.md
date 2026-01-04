# Platform API Guide

Singleton platform configuration API - stores all platform-wide settings in one document.

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/platform/config` | Public | Get platform config (supports field selection) |
| `PATCH` | `/api/v1/platform/config` | Admin | Update platform config |

---

## Get Platform Configuration

```http
GET /api/v1/platform/config
```

Returns full config or selected fields via query param.

**Field Selection** (space-separated, URL-encoded):
```http
GET /api/v1/platform/config?select=paymentMethods
GET /api/v1/platform/config?select=checkout%20vat
GET /api/v1/platform/config?select=vat%20logistics
GET /api/v1/platform/config?select=membership
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "platformName": "Big Boss Retail",
    "paymentMethods": [
      {
        "_id": "...",
        "type": "cash",
        "name": "Cash",
        "isActive": true
      },
      {
        "_id": "...",
        "type": "mfs",
        "provider": "bkash",
        "name": "bKash Personal",
        "walletNumber": "01712345678",
        "walletName": "Big Boss Store",
        "isActive": true
      },
      {
        "_id": "...",
        "type": "mfs",
        "provider": "nagad",
        "name": "Nagad Merchant",
        "walletNumber": "01812345678",
        "walletName": "Big Boss",
        "isActive": true
      },
      {
        "_id": "...",
        "type": "bank_transfer",
        "name": "DBBL Transfer",
        "bankName": "Dutch Bangla Bank",
        "accountNumber": "1234567890",
        "accountName": "Big Boss Ltd",
        "branchName": "Gulshan",
        "routingNumber": "090261234",
        "isActive": true
      },
      {
        "_id": "...",
        "type": "card",
        "name": "City Bank Cards",
        "bankName": "City Bank",
        "cardTypes": ["visa", "mastercard"],
        "note": "2% surcharge applies",
        "isActive": true
      }
    ],
    "checkout": {
      "allowStorePickup": true,
      "deliveryFeeSource": "provider",
      "freeDeliveryThreshold": 2000
    },
    "vat": {
      "isRegistered": true,
      "bin": "1234567890123",
      "registeredName": "Big Boss Retail",
      "vatCircle": "Dhaka Circle",
      "defaultRate": 15,
      "pricesIncludeVat": true,
      "invoice": {
        "prefix": "INV-",
        "showVatBreakdown": true
      },
      "supplementaryDuty": {
        "enabled": false,
        "defaultRate": 0
      }
    },
    "logistics": {
      "defaultPickupStoreId": 12345,
      "defaultPickupStoreName": "Main Warehouse",
      "defaultPickupAreaId": 1,
      "defaultPickupAreaName": "Dhaka",
      "autoCreateShipment": false,
      "autoCreateOnStatus": "processing"
    },
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
      "cardDigits": 8,
      "redemption": {
        "enabled": true,
        "minRedeemPoints": 100,
        "minOrderAmount": 0,
        "maxRedeemPercent": 50,
        "pointsPerBdt": 10
      }
    }
  }
}
```

---

## Update Platform Configuration

```http
PATCH /api/v1/platform/config
Authorization: Bearer <admin_token>
```

Partial update - send only fields to update.

**Request:**
```json
{
  "platformName": "My Store",
  "paymentMethods": [
    { "type": "cash", "name": "Cash", "isActive": true },
    { "type": "mfs", "provider": "bkash", "name": "bKash", "walletNumber": "01712345678", "walletName": "My Store" }
  ],
  "checkout": {
    "freeDeliveryThreshold": 1500
  }
}
```

**Response:** Same shape as GET with updated values.

---

## Payment Methods

Flexible array supporting multiple accounts per type.

### Payment Types

| Type | Description | Required Fields |
|------|-------------|-----------------|
| `cash` | Cash on delivery / in-store | `name` |
| `mfs` | Mobile Financial Services | `name`, `provider`, `walletNumber` |
| `bank_transfer` | Bank account transfers | `name`, `bankName`, `accountNumber` |
| `card` | Credit/Debit cards | `name`, `cardTypes` |

### MFS Providers

- `bkash` - bKash
- `nagad` - Nagad
- `rocket` - Rocket
- `upay` - Upay

### Card Types

- `visa`
- `mastercard`
- `amex`
- `unionpay`
- `other`

### Payment Method Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `cash`, `mfs`, `bank_transfer`, `card` |
| `name` | string | Display name (e.g., "bKash Personal") |
| `provider` | string | MFS provider (bkash, nagad, etc.) |
| `walletNumber` | string | MFS wallet number |
| `walletName` | string | MFS wallet name |
| `bankName` | string | Bank name |
| `accountNumber` | string | Bank account number |
| `accountName` | string | Bank account holder name |
| `branchName` | string | Bank branch |
| `routingNumber` | string | Bank routing number |
| `cardTypes` | array | Card types accepted |
| `note` | string | Additional notes |
| `isActive` | boolean | Whether method is available |

---

## Checkout Settings

Additional checkout-level settings in `checkout`:

| Field | Type | Description |
|-------|------|-------------|
| `checkout.allowStorePickup` | boolean | Allow store pickup at checkout |
| `checkout.pickupBranches[]` | array | Optional list of pickup branches (`branchId`, `branchCode`, `branchName`) |
| `checkout.deliveryFeeSource` | string | `provider` (courier API pricing) |
| `checkout.freeDeliveryThreshold` | number | Free delivery threshold (BDT) |

---

## VAT Settings

| Field | Type | Description |
|-------|------|-------------|
| `vat.vatCircle` | string | VAT circle/zone for filing |
| `vat.invoice.prefix` | string | Invoice number prefix |
| `vat.invoice.showVatBreakdown` | boolean | Show VAT breakdown on invoice |
| `vat.supplementaryDuty.enabled` | boolean | Enable supplementary duty |
| `vat.supplementaryDuty.defaultRate` | number | Default supplementary duty rate (%) |

---

## Membership Settings

Loyalty configuration lives in `membership` and powers POS/customer membership features.

| Field | Type | Description |
|-------|------|-------------|
| `membership.enabled` | boolean | Enable membership program |
| `membership.pointsPerAmount` | number | Points earned per amount bucket |
| `membership.amountPerPoint` | number | BDT amount per point |
| `membership.roundingMode` | string | `floor`, `round`, or `ceil` |
| `membership.tiers[]` | array | Tier rules (name/minPoints/multiplier/discount) |
| `membership.cardPrefix` | string | Prefix for card IDs (e.g., `MBR`) |
| `membership.cardDigits` | number | Numeric digits for card IDs |

### Membership Tiers

| Field | Type | Description |
|-------|------|-------------|
| `tiers[].name` | string | Tier name (Bronze, Silver, etc.) |
| `tiers[].minPoints` | number | Min lifetime points required |
| `tiers[].pointsMultiplier` | number | Earned points multiplier |
| `tiers[].discountPercent` | number | Automatic discount percentage |
| `tiers[].color` | string | Optional color for UI display |

### Redemption Rules

Configure point redemption in `membership.redemption`:

| Field | Type | Description |
|-------|------|-------------|
| `redemption.enabled` | boolean | Enable points redemption |
| `redemption.minRedeemPoints` | number | Minimum points required to redeem |
| `redemption.minOrderAmount` | number | Minimum order amount (BDT) |
| `redemption.maxRedeemPercent` | number | Max % of order total redeemable |
| `redemption.pointsPerBdt` | number | Points required per 1 BDT discount |

---

## VAT Configuration

| Field | Type | Description |
|-------|------|-------------|
| `vat.isRegistered` | boolean | VAT registration status |
| `vat.bin` | string | Business Identification Number (13 digits) |
| `vat.registeredName` | string | Business name as registered |
| `vat.vatCircle` | string | VAT circle (optional) |
| `vat.defaultRate` | number | Default VAT rate (%) |
| `vat.pricesIncludeVat` | boolean | Whether catalog prices include VAT |
| `vat.invoice.prefix` | string | Invoice number prefix |
| `vat.invoice.showVatBreakdown` | boolean | Show VAT on invoices |
| `vat.invoice.startNumber` | number | Initial invoice number seed |
| `vat.invoice.currentNumber` | number | Current invoice counter |
| `vat.invoice.footerText` | string | Invoice footer text |
| `vat.categoryRates[]` | array | Legacy category-level rates `{ category, rate, description }` |
| `vat.supplementaryDuty.enabled` | boolean | Enable supplementary duty |
| `vat.supplementaryDuty.defaultRate` | number | Default SD rate (%) |

---

## Logistics Configuration

Default pickup settings for courier shipment creation.

| Field | Type | Description |
|-------|------|-------------|
| `logistics.defaultPickupStoreId` | number | Default pickup store ID (from courier provider) |
| `logistics.defaultPickupStoreName` | string | Default pickup store name |
| `logistics.defaultPickupAreaId` | number | Default pickup area ID |
| `logistics.defaultPickupAreaName` | string | Default pickup area name |
| `logistics.webhookSecret` | string | Webhook secret (provider-specific) |
| `logistics.autoCreateShipment` | boolean | Auto-create shipment when order reaches status |
| `logistics.autoCreateOnStatus` | string | Order status that triggers auto-create |

---

## Membership Configuration

Loyalty points and tier-based discount program settings.

```http
GET /api/v1/platform/config?select=membership
```

**Response:**
```json
{
  "success": true,
  "data": {
    "membership": {
      "enabled": true,
      "pointsPerAmount": 1,
      "amountPerPoint": 100,
      "roundingMode": "floor",
      "tiers": [
        { "name": "Bronze", "minPoints": 0, "pointsMultiplier": 1, "discountPercent": 0, "color": "#CD7F32" },
        { "name": "Silver", "minPoints": 500, "pointsMultiplier": 1.25, "discountPercent": 2, "color": "#C0C0C0" },
        { "name": "Gold", "minPoints": 2000, "pointsMultiplier": 1.5, "discountPercent": 5, "color": "#FFD700" },
        { "name": "Platinum", "minPoints": 5000, "pointsMultiplier": 2, "discountPercent": 10, "color": "#E5E4E2" }
      ],
      "redemption": {
        "enabled": false,
        "pointsPerBdt": 10,
        "maxRedeemPercent": 50
      },
      "cardPrefix": "MBR",
      "cardDigits": 8
    }
  }
}
```

### Membership Fields

| Field | Type | Description |
|-------|------|-------------|
| `membership.enabled` | boolean | Enable/disable membership program |
| `membership.pointsPerAmount` | number | Points earned per unit (default: 1) |
| `membership.amountPerPoint` | number | BDT spent per point (default: 100) |
| `membership.roundingMode` | string | `floor`, `round`, or `ceil` |
| `membership.tiers[]` | array | Tier configuration (see below) |
| `membership.redemption.enabled` | boolean | Allow points redemption |
| `membership.redemption.pointsPerBdt` | number | Points needed for 1 BDT discount (default: 10) |
| `membership.redemption.maxRedeemPercent` | number | Max % of order payable with points (default: 50) |
| `membership.redemption.minRedeemPoints` | number | Minimum points for redemption (default: 100) |
| `membership.redemption.minOrderAmount` | number | Minimum order value for redemption (default: 0) |
| `membership.cardPrefix` | string | Card ID prefix (e.g., "MBR") |
| `membership.cardDigits` | number | Random digits in card ID |

### Tier Configuration

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Tier name (e.g., "Gold") |
| `minPoints` | number | Minimum lifetime points for tier |
| `pointsMultiplier` | number | Points earning multiplier (e.g., 1.5x) |
| `discountPercent` | number | Auto-discount for tier members (%) |

**Frontend Color Recommendations:**

Colors are defined in your frontend application (CSS/styling) based on tier name. Recommended colors for visual hierarchy:

```javascript
// Define in your frontend app
const TIER_COLORS = {
  'Bronze': '#CD7F32',
  'Silver': '#C0C0C0',
  'Gold': '#FFD700',
  'Platinum': '#E5E4E2'
};

function getTierColor(tierName) {
  return TIER_COLORS[tierName] || '#808080'; // Default gray
}
```

Use these colors in POS UI for tier badges, discount highlighting, and receipt display for instant visual feedback.

### Points Calculation Formula

```
basePoints = (orderTotal / amountPerPoint) * pointsPerAmount
earnedPoints = roundingMode(basePoints * tierMultiplier)
```

Where `roundingMode` is one of:
- `floor` (default) - Round down (10.9 → 10)
- `round` - Standard rounding (10.5 → 11, 10.4 → 10)
- `ceil` - Round up (10.1 → 11)

**Example:** Gold member (1.5x), 1000 BDT order, amountPerPoint=100, roundingMode=floor:
- Base: (1000 / 100) * 1 = 10 points
- With multiplier: 10 * 1.5 = 15 points

### Card ID Format

Card IDs are generated as: `{cardPrefix}-{randomDigits}`

Example with `cardPrefix: "MBR"` and `cardDigits: 8`:
- Generated ID: `MBR-12345678`

The dash separator is always included between prefix and digits.

### Enable Membership Program

```http
PATCH /api/v1/platform/config
Authorization: Bearer <admin_token>
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

### Redemption Configuration

Points redemption allows customers to use earned points for discounts at checkout. Configure in `membership.redemption`:

```json
{
  "redemption": {
    "enabled": true,
    "minRedeemPoints": 100,
    "minOrderAmount": 500,
    "maxRedeemPercent": 50,
    "pointsPerBdt": 10
  }
}
```

**Redemption Rules:**
- `enabled`: Master switch for points redemption feature
- `minRedeemPoints`: Minimum points required to start redemption (prevents small redemptions)
- `minOrderAmount`: Minimum order value (BDT) to allow redemption (e.g., can't redeem on orders < ৳500)
- `maxRedeemPercent`: Maximum % of order total that can be paid with points (prevents 100% point orders)
- `pointsPerBdt`: Conversion rate (e.g., 10 points = 1 BDT discount)

**Calculation Example:**
```
Order Total: ৳1,000
Customer Points: 500
Redemption Config: { pointsPerBdt: 10, maxRedeemPercent: 50 }

Max Redeemable: 50% of ৳1,000 = ৳500 = 5,000 points
Customer Has: 500 points = ৳50 discount
Result: Customer can redeem all 500 points for ৳50 discount
```

### Related APIs

- **Enroll Customer:** `POST /api/v1/customers/:id/membership { action: 'enroll' }` — see [Customer API](customer.md#membership-cards)
- **POS with Membership:** Pass `membershipCardId` and `pointsToRedeem` in order — see [POS API](commerce/pos.md#6-membership-cards)
- **Client-Side Calculations:** See [POS Performance Guide](commerce/pos.md#611-client-side-discount-calculations-performance-optimization) for real-time discount previews

---

## Frontend Usage

### Load Payment Methods for Checkout/POS

```javascript
const { data } = await fetch('/api/v1/platform/config?select=paymentMethods').then(r => r.json());

// Filter active methods
const activePayments = data.paymentMethods.filter(m => m.isActive);

// Group by type
const mfsMethods = activePayments.filter(m => m.type === 'mfs');
const bankMethods = activePayments.filter(m => m.type === 'bank_transfer');
const cardMethods = activePayments.filter(m => m.type === 'card');
```

### Load Delivery Options for Checkout

```javascript
const { data } = await fetch('/api/v1/platform/config?select=checkout').then(r => r.json());

// Check free delivery
const freeThreshold = data.checkout.freeDeliveryThreshold;

// Delivery price should come from logistics estimate API
// (see Logistics docs for provider pricing).
```

### Admin - Add Payment Method

```javascript
// Get current config
const { data: config } = await fetch('/api/v1/platform/config?select=paymentMethods').then(r => r.json());

// Add new method
const updated = [...config.paymentMethods, {
  type: 'mfs',
  provider: 'nagad',
  name: 'Nagad Business',
  walletNumber: '01912345678',
  walletName: 'Shop Name',
  isActive: true,
}];

// Update
await fetch('/api/v1/platform/config', {
  method: 'PATCH',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ paymentMethods: updated }),
});
```

---

## Notes

- **Singleton:** Only one platform config document exists; auto-created with defaults if missing.
- **Deep Merge:** PATCH updates use deep merge for nested objects (`vat`, `membership`, `checkout`, `logistics`, `policies`). Arrays (`paymentMethods`, `tiers`) are replaced entirely.
- **Field Selection:** Use `?select=field1%20field2` (space-separated, URL-encoded) to fetch only needed fields.
- **Payment Methods:** Multiple accounts per type supported (e.g., multiple bKash numbers).
- **Delivery Pricing:** Delivery zones are handled in Logistics; platform config only stores checkout settings and free delivery threshold.
- **Policies:** `policies.*` fields exist in platform config; if your setup uses CMS-managed policies, keep them in sync there instead of here.

### Validation Rules

**Payment Methods:**
- `mfs`: Requires `provider` (bkash/nagad/rocket/upay) and `walletNumber`
- `bank_transfer`: Requires `bankName` and `accountNumber`
- `card`: Requires at least one `cardType` (bankName is optional)

**Membership:**
- `pointsPerAmount`, `amountPerPoint`, `pointsPerBdt` must be ≥ 1
- `maxRedeemPercent` must be 0-100
- `minRedeemPoints`, `minOrderAmount` must be ≥ 0
- `discountPercent` per tier must be 0-100
- `pointsMultiplier` must be 0.1-10
- `minPoints` cannot be negative
