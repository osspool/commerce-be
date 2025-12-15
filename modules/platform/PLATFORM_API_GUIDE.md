# Platform API Guide

Singleton platform configuration API - stores all platform-wide settings in one document.

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/platform/config` | Public | Get platform config (supports field selection) |
| `PATCH` | `/api/v1/platform/config` | Admin | Update platform config (including deliveryOptions) |

---

## Config Endpoints

### Get Platform Configuration

```http
GET /api/v1/platform/config
```

Returns full config or selected fields via query param. Use `deliveryOptions` selection for delivery choices.

**Field Selection:**
```http
GET /api/v1/platform/config?select=payment,deliveryOptions
GET /api/v1/platform/config?select=policies
GET /api/v1/platform/config?select=deliveryOptions
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "platformName": "Big Boss Retail",
    "payment": {
      "cash": { "enabled": true },
      "bkash": { "walletNumber": "017...", "walletName": "...", "note": "..." },
      "nagad": { "walletNumber": "...", "walletName": "...", "note": "..." },
      "rocket": { "walletNumber": "...", "walletName": "...", "note": "..." },
      "bank": {
        "bankName": "...",
        "accountNumber": "...",
        "accountName": "...",
        "branchName": "...",
        "routingNumber": "...",
        "swiftCode": "...",
        "note": "..."
      }
    },
    "deliveryOptions": [
      {
        "_id": "...",
        "name": "Inside Dhaka",
        "region": "dhaka",
        "price": 60,
        "estimatedDays": 2,
        "isActive": true
      },
      {
        "_id": "...",
        "name": "Outside Dhaka",
        "region": "outside_dhaka",
        "price": 120,
        "estimatedDays": 5,
        "isActive": true
      }
    ],
    "policies": {
      "termsAndConditions": "...",
      "privacyPolicy": "...",
      "refundPolicy": "...",
      "shippingPolicy": "..."
    },
    "isSingleton": true,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

### Update Platform Configuration

```http
PATCH /api/v1/platform/config
Authorization: Bearer <admin_token>
```

Partial update - send only fields to update (including `deliveryOptions` array).

**Request:**
```json
{
  "platformName": "My Store",
  "payment": {
    "bkash": { "walletNumber": "01712345678", "walletName": "My Store", "note": "Personal" }
  },
  "policies": {
    "refundPolicy": "https://example.com/refund"
  }
}
```

**Response:** Same shape as GET with updated values.

---

## Managing Delivery Options (via Config)

- Delivery options live in `platform.config.deliveryOptions` (embedded array).
- Fetch (public): `GET /api/v1/platform/config?select=deliveryOptions`
- Update/add/remove (admin): `PATCH /api/v1/platform/config` with the updated `deliveryOptions` array.

---

## Data Schema

### Delivery Option Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name (e.g., "Inside Dhaka") |
| `region` | string | Yes | Region identifier (e.g., "dhaka", "outside_dhaka") |
| `price` | number | Yes | Delivery price in BDT (must be ≥ 0) |
| `estimatedDays` | number | No | Estimated delivery days |
| `isActive` | boolean | No | Whether option is available (default: true) |

### Payment Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `payment.cash.enabled` | boolean | Enable COD |
| `payment.bkash` | object | `{ walletNumber, walletName, note }` |
| `payment.nagad` | object | `{ walletNumber, walletName, note }` |
| `payment.rocket` | object | `{ walletNumber, walletName, note }` |
| `payment.bank` | object | `{ bankName, accountNumber, accountName, branchName, routingNumber, swiftCode, note }` |

### Policy Fields

| Field | Type | Description |
|-------|------|-------------|
| `policies.termsAndConditions` | string | Terms URL or content |
| `policies.privacyPolicy` | string | Privacy URL or content |
| `policies.refundPolicy` | string | Refund URL or content |
| `policies.shippingPolicy` | string | Shipping URL or content |

---

## Frontend Usage

### Checkout - Load Delivery Options

```javascript
const { data: { deliveryOptions } } = await fetch('/api/v1/platform/config?select=deliveryOptions').then(r => r.json());

// Populate dropdown (filter isActive on FE if desired)
deliveryOptions.forEach(opt => {
  // { _id, name, region, price, estimatedDays, isActive }
});
```

### Checkout - Load Payment Methods

```javascript
const { data: config } = await fetch('/api/v1/platform/config?select=payment').then(r => r.json());

// config.payment.bkash.walletNumber → show bKash number
// config.payment.cash.enabled → show COD option
```

### Admin - Update bKash Number

```javascript
await fetch('/api/platform/config', {
  method: 'PATCH',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payment: { bkash: { walletNumber: '01812345678' } }
  })
});
```

---

## Notes

- **Singleton:** Only one platform config document exists; auto-created with defaults if missing.
- **Field Selection:** Use `?select=field1,field2` to fetch only needed fields (reduces payload).
- **Delivery in Config:** Delivery options are embedded in platform config but have dedicated CRUD routes for convenience.
- **Migration:** If you had a separate `DeliveryPricing` collection, migrate data to `deliveryOptions` array in platform config.
