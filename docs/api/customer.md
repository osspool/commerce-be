# Customer API Guide

Quick reference for customer management and POS customer lookup.

> **Note:** Customers are auto-created during checkout/order flow. No direct create endpoint for public use.

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/customers` | Authenticated | List customers (with search) |
| `GET` | `/api/v1/customers/:id` | Authenticated | Get customer by ID |
| `GET` | `/api/v1/customers/me` | User/Admin | Get my customer profile |
| `PATCH` | `/api/v1/customers/:id` | Authenticated | Update customer |
| `DELETE` | `/api/v1/customers/:id` | Admin/Superadmin | Delete customer |
| `POST` | `/api/v1/customers/me/membership` | User | Self-service membership actions |
| `POST` | `/api/v1/customers/:id/membership` | Staff | All membership actions (enroll, deactivate, reactivate, adjust) |

---

## Customer Creation

Customers are **auto-created** in these flows:

1. **Web Checkout:** When a user places their first order, a customer record is created/linked
2. **POS Checkout:** Staff can create customers by providing phone number
3. **Guest Checkout:** Customer created by phone (can be linked to user later)

---

## List Customers (with Search)

```http
GET /api/v1/customers?search=<query>&page=1&limit=20
Authorization: Bearer <token>
```

### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Full-text search by name, phone, or email |
| `phone` | string | Filter by exact phone match |
| `phone[contains]` | string | Filter by partial phone match |
| `email` | string | Filter by exact email match |
| `name` | string | Filter by exact name match |
| `name[contains]` | string | Filter by partial name match |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20, max: 100) |
| `sort` | string | Sort field (default: `-createdAt`) |
| `populate` | string | Populate relations: `userId` |

### Filter Operators

| Operator | Example | Description |
|----------|---------|-------------|
| (none) | `?phone=01712345678` | Exact match |
| `[eq]` | `?phone[eq]=01712345678` | Explicit exact match |
| `[contains]` | `?phone[contains]=0171` | Partial match (regex) |
| `[like]` | `?name[like]=rahim` | Partial match (regex) |
| `[in]` | `?tags[in]=vip,wholesale` | Match any in list |
| `[gt]` | `?stats.revenue.lifetime[gt]=10000` | Greater than |
| `[gte]` | `?stats.revenue.lifetime[gte]=10000` | Greater than or equal |
| `[lt]` | `?stats.orders.total[lt]=5` | Less than |
| `[lte]` | `?stats.orders.total[lte]=5` | Less than or equal |

### Search Examples

**Exact phone match (POS quick lookup):**
```http
GET /api/v1/customers?phone=01712345678
```

**Partial phone match:**
```http
GET /api/v1/customers?phone[contains]=0171234
```

**Search by name (fuzzy):**
```http
GET /api/v1/customers?search=rahim
```

**Partial name match:**
```http
GET /api/v1/customers?name[contains]=rahim
```

**Paginated with sorting:**
```http
GET /api/v1/customers?page=1&limit=10&sort=-stats.revenue.lifetime
```

**High-value customers:**
```http
GET /api/v1/customers?stats.revenue.lifetime[gte]=50000&sort=-stats.revenue.lifetime
```

### Response

```json
{
  "success": true,
  "docs": [
    {
      "_id": "customer_id",
      "name": "Rahim Ahmed",
      "phone": "01712345678",
      "email": "rahim@example.com",
      "addresses": [...],
      "stats": {
        "orders": { "total": 5, "completed": 4, "cancelled": 1, "refunded": 0 },
        "revenue": { "total": 15000, "lifetime": 15000 },
        "firstOrderDate": "2025-01-01T00:00:00.000Z",
        "lastOrderDate": "2025-12-15T00:00:00.000Z"
      },
      "tags": ["vip", "pos"],
      "tier": "silver",
      "isActive": true,
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "total": 150,
  "page": 1,
  "pages": 15,
  "hasNext": true,
  "hasPrev": false,
  "limit": 10
}
```

---

## Get Customer by ID

```http
GET /api/v1/customers/:id
Authorization: Bearer <token>
```

### Response

```json
{
  "success": true,
  "data": {
    "_id": "customer_id",
    "userId": "user_id",
    "name": "Rahim Ahmed",
    "phone": "01712345678",
    "email": "rahim@example.com",
    "dateOfBirth": "1990-05-15T00:00:00.000Z",
    "gender": "male",
    "addresses": [
      {
        "_id": "address_id",
        "label": "Home",
        "recipientName": "Rahim Ahmed",
        "recipientPhone": "01712345678",
        "addressLine1": "House 12, Road 5",
        "addressLine2": "Block C",
        "city": "Dhaka",
        "division": "Dhaka",
        "postalCode": "1207",
        "areaId": 1,
        "areaName": "Mohammadpur",
        "zoneId": 1,
        "providerAreaIds": { "redx": 1, "pathao": 101 },
        "isDefault": true
      }
    ],
    "stats": {
      "orders": { "total": 5, "completed": 4, "cancelled": 1, "refunded": 0 },
      "revenue": { "total": 15000, "lifetime": 15000 },
      "firstOrderDate": "2025-01-01T00:00:00.000Z",
      "lastOrderDate": "2025-12-15T00:00:00.000Z"
    },
    "tags": ["vip"],
    "notes": "Prefers express delivery",
    "tier": "silver",
    "defaultAddress": { ... },
    "isActive": true,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-12-15T00:00:00.000Z"
  }
}
```

---

## Get My Profile

Returns the authenticated user's customer profile. Auto-creates if not exists.

```http
GET /api/v1/customers/me
Authorization: Bearer <token>
```

### Response

Same as "Get Customer by ID" response.

---

## Update Customer

```http
PATCH /api/v1/customers/:id
Authorization: Bearer <token>
```

### Request Body

```json
{
  "name": "Rahim Ahmed Khan",
  "email": "rahim.khan@example.com",
  "dateOfBirth": "1990-05-15",
  "gender": "male",
  "tags": ["vip", "wholesale"],
  "notes": "Prefers express delivery",
  "isActive": true
}
```

### Editable Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Customer name |
| `email` | string | Email address (unique) |
| `phone` | string | Phone number (unique) |
| `dateOfBirth` | date | Date of birth |
| `gender` | string | `male`, `female`, `other`, `prefer-not-to-say` |
| `tags` | string[] | Custom tags for segmentation |
| `notes` | string | Admin notes |
| `isActive` | boolean | Active status |

### System-Managed Fields (Read-only)

These fields are auto-calculated and cannot be set via API:

- `userId` - Auto-linked from user account
- `stats.orders.*` - Order statistics
- `stats.revenue.*` - Revenue statistics
- `stats.firstOrderDate` - First order timestamp
- `stats.lastOrderDate` - Last order timestamp

### Response

```json
{
  "success": true,
  "data": { ... }
}
```

---

## Delete Customer

```http
DELETE /api/v1/customers/:id
Authorization: Bearer <admin_token>
```

> **Warning:** Only Admin/Superadmin can delete customers. Consider deactivating (`isActive: false`) instead.

### Response

```json
{
  "success": true,
  "message": "Document deleted"
}
```

---

## POS Customer Lookup

For POS checkout, use filters to quickly find customers by phone:

### Quick Phone Lookup (Exact Match)

```http
GET /api/v1/customers?phone=01712345678
Authorization: Bearer <token>
```

### Partial Phone Lookup

```http
GET /api/v1/customers?phone[contains]=0171234
Authorization: Bearer <token>
```

### Fuzzy Search (Name/Phone/Email)

```http
GET /api/v1/customers?search=rahim
Authorization: Bearer <token>
```

### POS Checkout Flow

```javascript
// 1. Search for customer by phone (exact match)
const res = await fetch(`/api/v1/customers?phone=${phone}`, {
  headers: { Authorization: `Bearer ${token}` }
});
const { docs } = await res.json();

// 2. If found, use existing customer
if (docs.length > 0) {
  const customer = docs[0];
  // Use customer._id in POS checkout
}

// 3. If not found, POS checkout will create customer automatically
// Just pass customerData: { name, phone } in POS order payload
```

---

## Customer Tiers

Customers have **two separate tier systems**:

### 1. Revenue-Based Tier (`customer.tier`)

Virtual field calculated from `stats.revenue.lifetime` (stored in BDT):

| Tier | Lifetime Revenue |
|------|-----------------|
| `bronze` | < ৳10,000 |
| `silver` | ৳10,000 - ৳49,999 |
| `gold` | ৳50,000 - ৳99,999 |
| `platinum` | ≥ ৳100,000 |

> **Note:** This tier is for **analytics/segmentation only**. It does NOT provide discounts or benefits. Use `customer.membership.tier` for loyalty benefits.

### 2. Membership Points Tier (`customer.membership.tier`)

For customers with a membership card, tier is based on **lifetime points earned**. Thresholds and discounts are **fully configurable** via Platform Config.

**Example configuration** (your values may differ):

| Tier | Points Required | Discount |
|------|-----------------|----------|
| `Bronze` | 0 | 0% |
| `Silver` | 500+ | 2% |
| `Gold` | 2,000+ | 5% |
| `Platinum` | 5,000+ | 10% |

> **Note:** Membership tier provides automatic discounts at POS/checkout. Configure via `PATCH /api/v1/platform/config` → `membership.tiers[]`.

---

## Membership API

Customers can optionally have membership cards for loyalty points and tier-based discounts.

The Membership API follows **Stripe-style action-based routing** - single endpoint with action in body.

### Action-Based Endpoint

```http
POST /api/v1/customers/:id/membership
Authorization: Bearer <staff_token>
Content-Type: application/json

{ "action": "enroll" | "deactivate" | "reactivate" | "adjust", ...params }
```

| Action | Description | Additional Params |
|--------|-------------|-------------------|
| `enroll` | Enroll customer in membership | - |
| `deactivate` | Deactivate membership card | - |
| `reactivate` | Reactivate membership card | - |
| `adjust` | Add/deduct points manually | `points`, `reason`, `type` |

### Self-Service Endpoint

```http
POST /api/v1/customers/me/membership
Authorization: Bearer <customer_token>

{ "action": "enroll" }
```

Only `enroll` action is available for self-service.

### Examples

**Enroll customer:**
```json
{ "action": "enroll" }
```

**Deactivate membership:**
```json
{ "action": "deactivate" }
```

**Add bonus points (admin):**
```json
{
  "action": "adjust",
  "points": 500,
  "reason": "Birthday bonus",
  "type": "bonus"
}
```

**Deduct points (correction):**
```json
{
  "action": "adjust",
  "points": -100,
  "reason": "Refund adjustment",
  "type": "correction"
}
```

### Adjustment Types

| Type | Description | Affects Lifetime |
|------|-------------|------------------|
| `bonus` | Promotional/reward points | Yes (counts for tier) |
| `correction` | Error fix | No |
| `manual_redemption` | Manual points usage | No (tracks in redeemed) |
| `redemption` | POS/checkout redemption | No (tracks in redeemed) |
| `expiry` | Expired points removal | No |

**Response:**

```json
{
  "success": true,
  "data": {
    "_id": "customer_id",
    "name": "Rahim Ahmed",
    "membership": {
      "cardId": "MBR-12345678",
      "isActive": true,
      "enrolledAt": "2025-01-01T00:00:00Z",
      "points": { "current": 500, "lifetime": 500, "redeemed": 0 },
      "tier": "Silver"
    }
  },
  "adjustment": {
    "points": 500,
    "type": "bonus",
    "reason": "Birthday bonus",
    "balanceBefore": 0,
    "balanceAfter": 500
  },
  "message": "Points adjusted: +500"
}
```

> **Note:** Enrollment requires membership to be enabled in Platform Config (`membership.enabled: true`).

### Membership Data in Customer Response

When a customer has a membership card, it's included in all customer responses:

```json
{
  "_id": "customer_id",
  "name": "Rahim Ahmed",
  "phone": "01712345678",
  "membership": {
    "cardId": "MBR-12345678",
    "isActive": true,
    "enrolledAt": "2025-01-01T00:00:00Z",
    "points": {
      "current": 2150,
      "lifetime": 2500,
      "redeemed": 350
    },
    "tier": "Gold"
  }
}
```

### Lookup by Membership Card

```http
GET /api/v1/customers?membership.cardId=MBR-12345678
Authorization: Bearer <token>
```

### Membership Fields

| Field | Type | Description |
|-------|------|-------------|
| `membership.cardId` | string | Unique card ID (e.g., `MBR-12345678`) |
| `membership.isActive` | boolean | Card active status |
| `membership.enrolledAt` | date | Enrollment timestamp |
| `membership.points.current` | number | Available points for redemption |
| `membership.points.lifetime` | number | Total points earned (for tier calculation) |
| `membership.points.redeemed` | number | Total points redeemed historically |
| `membership.tier` | string | Current tier (Bronze, Silver, Gold, Platinum) |
| `membership.tierOverride` | string | Manual tier override (for VIP customers) |

### Using Membership at POS

When processing a POS order with a membership customer:

1. **Scan/Enter Card ID**: Pass `membershipCardId` in POS order request
2. **Auto Lookup**: Customer is resolved from card ID
3. **Tier Discount**: Auto-applied based on tier configuration
4. **Points Earned**: Calculated from order total and tier multiplier
5. **Receipt**: Shows membership info (card, tier, points earned, discount)

See [POS API Guide](commerce/pos.md#6-membership-cards) for full details.

---

## Address Management

Addresses are embedded in the customer document. Use PATCH to manage addresses.

### Add Address

```http
PATCH /api/v1/customers/:id
Authorization: Bearer <token>
```

```json
{
  "addresses": [
    {
      "label": "Office",
      "recipientName": "Rahim Ahmed",
      "recipientPhone": "01712345678",
      "addressLine1": "Floor 5, Building A",
      "addressLine2": "Gulshan Avenue",
      "city": "Dhaka",
      "division": "Dhaka",
      "postalCode": "1212",
      "areaId": 10,
      "areaName": "Gulshan",
      "zoneId": 1,
      "providerAreaIds": { "redx": 10, "pathao": 110 },
      "isDefault": false
    }
  ]
}
```

> **Note:** First address added is automatically set as default. Setting `isDefault: true` on a new address will unset other defaults.

### Address Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | No | Address label (Home, Office, etc.) |
| `recipientName` | string | No | Recipient name for delivery |
| `recipientPhone` | string | No | Contact phone for delivery |
| `addressLine1` | string | No | Street address |
| `addressLine2` | string | No | Additional address info |
| `city` | string | No | City/District |
| `division` | string | No | Division |
| `postalCode` | string | No | Postal code |
| `areaId` | number | No | Area ID from bd-areas |
| `areaName` | string | No | Area name |
| `zoneId` | number | No | Delivery zone (1-6) |
| `providerAreaIds` | object | No | Provider-specific IDs (redx, pathao) |
| `isDefault` | boolean | No | Default address flag |

---

## TypeScript Types

```typescript
interface Customer {
  _id: string;
  userId?: string;              // Link to User account
  name: string;
  phone: string;                // Unique identifier
  email?: string;               // Unique when present
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other' | 'prefer-not-to-say';
  addresses: CustomerAddress[];
  stats: CustomerStats;
  tags: string[];
  notes?: string;
  isActive: boolean;
  membership?: CustomerMembership; // Loyalty card (null if not enrolled)

  // Virtuals (read-only)
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';  // Revenue-based (analytics only)
  defaultAddress?: CustomerAddress;

  createdAt: Date;
  updatedAt: Date;
}

interface CustomerMembership {
  cardId: string;               // e.g., "MBR-12345678"
  isActive: boolean;
  enrolledAt: Date;
  points: {
    current: number;            // Available for redemption
    lifetime: number;           // Total earned (for tier calculation)
    redeemed: number;           // Total redeemed historically
  };
  tier: string;                 // Points-based tier (provides discounts)
  tierOverride?: string;        // Manual override for VIP customers
  tierOverrideReason?: string;
  tierOverrideBy?: string;      // User ID who set override
}

interface CustomerAddress {
  _id: string;
  label?: string;
  recipientName?: string;
  recipientPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  division?: string;
  postalCode?: string;
  country: string;              // Default: 'Bangladesh'
  areaId?: number;
  areaName?: string;
  zoneId?: number;
  providerAreaIds?: {
    redx?: number;
    pathao?: number;
  };
  isDefault: boolean;
}

interface CustomerStats {
  orders: {
    total: number;
    completed: number;
    cancelled: number;
    refunded: number;
  };
  revenue: {
    total: number;              // In BDT
    lifetime: number;           // In BDT
  };
  firstOrderDate?: Date;
  lastOrderDate?: Date;
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
| 400 | Validation error, phone already in use |
| 401 | Not authenticated |
| 403 | Access denied |
| 404 | Customer not found |

---

## Frontend Tips

1. **POS Quick Lookup:** Use `?phone=<phone>` for exact match, `?phone[contains]=<partial>` for partial, `?search=<query>` for fuzzy
2. **Customer Creation:** Don't call create endpoint - pass customer data in POS/checkout payload
3. **Address Selection:** Use `customer.defaultAddress` virtual for pre-selecting shipping address
4. **Loyalty Tier Display:** Use `customer.membership?.tier` for loyalty program benefits (discounts). Use `customer.tier` only for analytics/segmentation
5. **Stats Display:** Show order count and lifetime revenue from `customer.stats` (values are in BDT)
6. **Filter Syntax:** Use `field=value` or `field[operator]=value`, NOT `filter[field]=value`
