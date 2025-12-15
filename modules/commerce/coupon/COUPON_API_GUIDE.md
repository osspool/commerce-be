# Coupon API Guide

CRUD + validation endpoints for coupons. All routes are prefixed with `/api/coupons`.

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/coupons` | Admin | List coupons (filterable, paginated) |
| `GET` | `/api/coupons/:id` | Admin | Get a coupon by id |
| `POST` | `/api/coupons` | Admin | Create coupon |
| `PATCH` | `/api/coupons/:id` | Admin | Update coupon |
| `DELETE` | `/api/coupons/:id` | Admin | Delete coupon |
| `POST` | `/api/coupons/validate/:code` | User/Admin | Validate coupon for an order amount |

Auth roles come from `coupon.plugin` presets: CRUD requires admin; validation accepts authenticated users or admins.

---

## CRUD Endpoints (Admin)

### List Coupons
```http
GET /api/coupons?code=SUMMER10&discountType=percentage&isActive=true&page=1&limit=20
Authorization: Bearer <admin_token>
```
- Filters: `code`, `discountType` (`percentage|fixed`), `isActive` (boolean).
- Pagination: default `limit=20`, max `limit=100`.

### Get One
```http
GET /api/coupons/:id
Authorization: Bearer <admin_token>
```

### Create
```http
POST /api/coupons
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "code": "SUMMER10",
  "discountType": "percentage",
  "discountAmount": 10,
  "minOrderAmount": 1000,
  "maxDiscountAmount": 500,
  "expiresAt": "2025-12-31T23:59:59.000Z",
  "usageLimit": 100,
  "isActive": true
}
```

### Update
```http
PATCH /api/coupons/:id
Authorization: Bearer <admin_token>
Content-Type: application/json

{ "isActive": false }
```

### Delete
```http
DELETE /api/coupons/:id
Authorization: Bearer <admin_token>
```

---

## Validate Coupon (User/Admin)

```http
POST /api/coupons/validate/:code
Authorization: Bearer <token>
Content-Type: application/json

{ "orderAmount": 2500 }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "code": "SUMMER10",
    "discountType": "percentage",
    "discountAmount": 10,
    "discount": 250,
    "finalAmount": 2250
  }
}
```

Errors return `400` with `{ success: false, message }` (e.g., not found, expired, below minimum order).

---

## Data Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | string | Yes | Unique, uppercased, trimmed |
| `discountType` | string | Yes | `percentage` or `fixed` |
| `discountAmount` | number | Yes | Positive; percent value or fixed amount |
| `minOrderAmount` | number | No | Default `0`; must be met to use |
| `maxDiscountAmount` | number | No | Cap for percentage discounts |
| `expiresAt` | date | Yes | Coupon must be unexpired |
| `usageLimit` | number | No | Default `100` |
| `usedCount` | number | System | Auto-managed usage counter |
| `isActive` | boolean | No | Default `true` |
| `createdAt`/`updatedAt` | date | Auto | Added by timestamps |

Notes:
- A coupon is valid when `isActive`, not expired, `usedCount < usageLimit`, and `orderAmount >= minOrderAmount`.
- `calculateDiscount` ensures discount never exceeds `maxDiscountAmount` (for percentage) or the order total.
