# Logistics API

Utilities for shipping providers, delivery charges, and tracking.

Base URL: `/api/v1/logistics`

---

## Delivery Charge (Provider API)

```http
GET /api/v1/logistics/charge?deliveryAreaId=1206&amount=1000&weight=500&provider=redx
```

**Query Params:**
| Param | Required | Description |
|-------|----------|-------------|
| `deliveryAreaId` | Yes | Area `internalId` from @classytic/bd-areas |
| `amount` | Yes | COD amount in BDT (use 0 for prepaid) |
| `weight` | No | Parcel weight in grams |
| `pickupAreaId` | No | Pickup area `internalId` |
| `provider` | No | Provider override |

**Response:**
```json
{
  "success": true,
  "data": {
    "deliveryCharge": 60,
    "codCharge": 15,
    "totalCharge": 75
  }
}
```

---

## Pickup Stores

```http
GET /api/v1/logistics/pickup-stores
Authorization: Bearer <admin_token>
```

Optional query: `?provider=redx`

---

## Track Shipment

```http
GET /api/v1/logistics/shipments/:id/track
Authorization: Bearer <admin_token>
```

`:id` can be order ID or tracking number. Returns stored `shipping` data plus live provider tracking.

---

## Create Shipment (Provider API)

```http
POST /api/v1/orders/:orderId/shipping
Authorization: Bearer <admin_token>
```

### Manual Entry (No API Call)

For manual tracking entry without calling provider API:

```json
{
  "provider": "redx",
  "trackingNumber": "ABC123456",
  "trackingUrl": "https://redx.com.bd/track/ABC123456"
}
```

### Provider API Integration (RedX)

To create a shipment via RedX API:

```json
{
  "provider": "redx",
  "useProviderApi": true,
  "pickupStoreId": 123,
  "weight": 500,
  "instructions": "Handle with care"
}
```

**⚠️ IMPORTANT: Order Must Have `providerAreaIds`**

For provider API integration to work, the order's `deliveryAddress` **must include `providerAreaIds`** from checkout.

**Frontend Checkout Requirement:**

```javascript
import { searchAreas } from '@classytic/bd-areas';

// When user selects area
const area = searchAreas('mohammadpur')[0];
// area = {
//   internalId: 1206,
//   name: 'Mohammadpur',
//   providers: { redx: 1, pathao: 101 }  // ← Provider-specific IDs
// }

// Include in order creation
const orderPayload = {
  deliveryAddress: {
    areaId: area.internalId,           // Our internal ID
    areaName: area.name,
    providerAreaIds: area.providers,   // ← REQUIRED for provider API
    // ...other fields
  }
};
```

**Backend Resolution Flow:**

1. `order.deliveryAddress.providerAreaIds.redx` → Used directly
2. Fallback: `bdAreas.getArea(areaId).providers.redx` → Lookup from bd-areas
3. If neither found → **API Error: "Not a valid delivery_area_id"**

---

## Cancel Shipment

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

## Provider Statuses (Webhook Input)

Providers send these raw statuses. Backend normalizes them into order shipping statuses.

```
pickup-requested, pickup-pending, picked-up, ready-for-delivery,
in-transit, agent-hold, delivery-in-progress, out-for-delivery,
delivered, failed-attempt, agent-returning, returning, returned,
cancelled, on-hold
```

See `docs/api/sales/order.md` for normalized order shipping statuses and mapping.
