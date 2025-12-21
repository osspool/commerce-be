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
      "defaultRate": 15,
      "pricesIncludeVat": true,
      "invoice": {
        "prefix": "INV-",
        "showVatBreakdown": true
      }
    },
    "logistics": {
      "defaultPickupStoreId": 12345,
      "defaultPickupStoreName": "Main Warehouse",
      "defaultPickupAreaId": 1,
      "defaultPickupAreaName": "Dhaka",
      "autoCreateShipment": false,
      "autoCreateOnStatus": "processing"
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
| `card` | Credit/Debit cards | `name`, `bankName`, `cardTypes` |

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
- **Field Selection:** Use `?select=field1%20field2` (space-separated, URL-encoded) to fetch only needed fields.
- **Payment Methods:** Multiple accounts per type supported (e.g., multiple bKash numbers).
- **Delivery Pricing:** Delivery zones are handled in Logistics; platform config only stores checkout settings and free delivery threshold.
- **Policies:** `policies.*` fields exist in platform config; if your setup uses CMS-managed policies, keep them in sync there instead of here.
