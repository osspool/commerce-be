# Review API Guide

Product reviews with verified purchase checks and moderation support.

Base path: `/api/v1/reviews`

## Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/reviews` | Public | List reviews (filterable) |
| `GET` | `/api/v1/reviews/:id` | Public | Get review by ID |
| `POST` | `/api/v1/reviews` | User/Admin | Create review |
| `PATCH` | `/api/v1/reviews/:id` | User/Admin | Update own review |
| `DELETE` | `/api/v1/reviews/:id` | Admin | Delete review |
| `GET` | `/api/v1/reviews/my/:productId` | User/Admin | Get my review for product |

## List Reviews

```http
GET /api/v1/reviews?product=<productId>&status=approved&page=1&limit=20
```

**Filter params:**
- `product` - Product ID
- `user` - User ID
- `rating` - Rating value (1-5)
- `status` - `pending`, `approved`, `rejected`
- `isVerifiedPurchase` - `true` or `false`
- `page`, `limit`, `after`, `sort` - Standard pagination/sort

## Create Review

```http
POST /api/v1/reviews
Authorization: Bearer <token>
```

```json
{
  "product": "product_id",
  "rating": 5,
  "title": "Great quality",
  "comment": "Fits well and feels premium."
}
```

**Notes:**
- Only one review per user per product (enforced).
- `isVerifiedPurchase` and `order` are set by the server.

## Update Review

```http
PATCH /api/v1/reviews/:id
Authorization: Bearer <token>
```

```json
{
  "rating": 4,
  "comment": "Updated after a week of use."
}
```

## Get My Review for Product

```http
GET /api/v1/reviews/my/:productId
Authorization: Bearer <token>
```

Returns your review or `null` if not found.

## Review Object (Response)

```json
{
  "_id": "review_id",
  "user": "user_id",
  "product": "product_id",
  "order": "order_id",
  "title": "Great quality",
  "rating": 5,
  "comment": "Fits well and feels premium.",
  "helpfulCount": 0,
  "isVerifiedPurchase": true,
  "status": "approved",
  "reply": {
    "content": "Thanks for your feedback!",
    "repliedBy": "admin_id",
    "repliedAt": "2025-01-10T10:00:00.000Z"
  },
  "createdAt": "2025-01-10T09:00:00.000Z",
  "updatedAt": "2025-01-10T09:00:00.000Z"
}
```
