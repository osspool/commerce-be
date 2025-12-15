# Product API Guide

Complete guide to the Product API endpoints with pagination, filtering, and search capabilities.

## Table of Contents
- [Base URL](#base-url)
- [Authentication](#authentication)
- [Pagination Modes](#pagination-modes)
- [CRUD Endpoints](#crud-endpoints)
- [Custom Endpoints](#custom-endpoints)
- [Query Parameters](#query-parameters)
- [Response Formats](#response-formats)
- [Examples](#examples)

---

## Base URL

```
/api/v1/products
```

> All endpoints below include the `/api/v1` prefix.

---

## Authentication

| Operation | Auth Required | Roles |
|-----------|---------------|-------|
| List Products | No | Public |
| Get Product | No | Public |
| Create Product | Yes | `admin` |
| Update Product | Yes | `admin` |
| Delete Product | Yes | `admin` |

---

## Pagination Modes

The API supports **two pagination modes** that are **auto-detected** based on query parameters:

### 1. Offset Pagination (Page-Based)
**Best for:** Admin dashboards, page numbers, showing total counts

**Trigger:** Include `page` parameter in query

**Response includes:**
- `method`: `"offset"`
- `docs`: Array of products
- `total`: Total count of matching products
- `pages`: Total number of pages
- `page`: Current page number
- `hasNext`: Boolean - has next page
- `hasPrev`: Boolean - has previous page

### 2. Keyset Pagination (Cursor-Based)
**Best for:** Infinite scroll, real-time feeds, large datasets

**Trigger:** Include `after` or `cursor` parameter, OR use `sort` without `page`

**Response includes:**
- `method`: `"keyset"`
- `docs`: Array of products
- `hasMore`: Boolean - has more results
- `next`: Cursor token for next page (opaque string)

**Performance:** O(1) regardless of position (requires proper indexes)

---

## CRUD Endpoints

### List Products
```http
GET /api/products
```

**Query Parameters:** See [Query Parameters](#query-parameters) section

**Payload size tip (FE-controlled):** API returns full product objects by default. Pass `select` to trim heavy fields, e.g. `?select=name,slug,basePrice,images` or to exclude with `?select=-properties,-variations` for lighter lists.

**Response:** See [Pagination Response Formats](#pagination-response-formats)

---

### Get Product by ID
```http
GET /api/products/:id
```

**Parameters:**
- `id` (path, required): Product ID

**Query Parameters:**
- `select`: Space or comma-separated fields to select
- `populate`: Not supported (images store URLs directly with variants; category is stored as string)

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "name": "Premium Wireless Headphones",
    "slug": "premium-wireless-headphones",
    "description": "High-quality wireless headphones with noise cancellation",
    "basePrice": 299.99,
    "costPrice": 180.00,
    "currentPrice": 249.99,
    "profitMargin": 69.99,
    "profitMarginPercent": 28.00,
    "quantity": 50,
    "category": "electronics",
    "parentCategory": "audio",
    "images": [
      {
        "url": "https://cdn.example.com/products/premium-headphones/hero.webp",
        "variants": {
          "thumbnail": "https://cdn.example.com/products/premium-headphones/hero-thumb.webp",
          "medium": "https://cdn.example.com/products/premium-headphones/hero-medium.webp"
        },
        "order": 0,
        "isFeatured": true,
        "alt": "Front view"
      }
    ],
    "featuredImage": {
      "url": "https://cdn.example.com/products/premium-headphones/hero.webp",
      "variants": {
        "thumbnail": "https://cdn.example.com/products/premium-headphones/hero-thumb.webp",
        "medium": "https://cdn.example.com/products/premium-headphones/hero-medium.webp"
      },
      "order": 0,
      "isFeatured": true,
      "alt": "Front view"
    },
    "variations": [],
    "properties": {},
    "tags": ["wireless", "noise-cancellation", "bluetooth"],
    "stats": {
      "totalSales": 150,
      "totalQuantitySold": 150,
      "viewCount": 1234
    },
    "averageRating": 4.5,
    "numReviews": 48,
    "discount": {
      "type": "percentage",
      "value": 15,
      "startDate": "2025-12-01T00:00:00.000Z",
      "endDate": "2025-12-31T23:59:59.999Z",
      "description": "Holiday Sale"
    },
    "isActive": true,
    "isDiscountActive": true,
    "totalSales": 150,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-12-05T00:00:00.000Z"
  }
}
```

---

### Get Product by Slug
```http
GET /api/products/slug/:slug
```

**Parameters:**
- `slug` (path, required): Product slug (auto-generated from name)

**Query Parameters:**
- `select`: Space or comma-separated fields to select

**Response:** Same shape as Get by ID.

---

### Create Product
```http
POST /api/products
```

**Auth Required:** Yes (admin)

**Request Body:**
```json
{
  "name": "Premium Wireless Headphones",
  "description": "High-quality wireless headphones",
  "basePrice": 299.99,
  "costPrice": 180.00,
  "quantity": 50,
  "category": "electronics",
  "parentCategory": "audio",
      "images": [
        {
          "url": "https://cdn.example.com/products/premium-headphones/hero.webp",
          "variants": {
            "thumbnail": "https://cdn.example.com/products/premium-headphones/hero-thumb.webp",
            "medium": "https://cdn.example.com/products/premium-headphones/hero-medium.webp"
          },
          "order": 0,
          "isFeatured": true,
          "alt": "Front view"
        }
      ],
  "tags": ["wireless", "bluetooth"],
  "discount": {
    "type": "percentage",
    "value": 15,
    "startDate": "2025-12-01",
    "endDate": "2025-12-31",
    "description": "Holiday Sale"
  }
}
```

**Required Fields:**
- `name` (string)
- `category` (string)
- `basePrice` (number, min: 0)
- `quantity` (number, min: 0) - Initial stock only. Use POS API to update later.

**Optional Admin Fields:**
- `costPrice` (number, min: 0) - For profit calculations. Only visible to admin/store-manager.

**System-Managed Fields (Auto-Generated, Cannot Update After Creation):**
- `slug` - Auto-generated from name
- `quantity` - Use POS Inventory API to update stock after creation
- `variations.*.options.*.quantity` - Use POS Inventory API
- `stats.*` - Auto-updated by system
- `averageRating` - Auto-calculated from reviews
- `numReviews` - Auto-updated from reviews

**Response:**
```json
{
  "success": true,
  "data": { /* Product object */ }
}
```

---

### Update Product
```http
PATCH /api/products/:id
```

**Auth Required:** Yes (admin)

**Parameters:**
- `id` (path, required): Product ID

**Request Body:** Partial product object (only fields to update)

```json
{
  "name": "Updated Product Name",
  "basePrice": 349.99,
  "discount": {
    "type": "percentage",
    "value": 20
  }
}
```

**⚠️ Cannot Update:** `quantity`, `stats`, `slug`, `averageRating`, `numReviews` (system-managed)
**💡 To Update Stock:** Use `PUT /api/v1/pos/inventory/:productId` - See [docs/.fe/INVENTORY_QUICK_START.md](../../docs/.fe/INVENTORY_QUICK_START.md)

**Response:**
```json
{
  "success": true,
  "data": { /* Updated product object */ }
}
```

---

### Delete Product
```http
DELETE /api/products/:id
```

**Auth Required:** Yes (admin)

**Parameters:**
- `id` (path, required): Product ID

**Response:**
```json
{
  "success": true,
  "message": "Product deleted successfully"
}
```

---

## Custom Endpoints

### Get Product Recommendations
```http
GET /api/products/:productId/recommendations
```

**Auth Required:** No

**Parameters:**
- `productId` (path, required): Product ID

**Returns:** Up to 4 products from the same category, sorted by total sales

**Response:**
```json
{
  "success": true,
  "data": [
    { /* Product object */ },
    { /* Product object */ },
    { /* Product object */ },
    { /* Product object */ }
  ]
}
```

---

## Query Parameters

### Pagination Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number (triggers offset pagination) |
| `after` | string | - | Cursor token (triggers keyset pagination) |
| `cursor` | string | - | Alias for `after` |
| `limit` | number | 20 | Items per page (max: 100) |
| `sort` | string | `-createdAt` | Sort fields (prefix with `-` for descending) |

**Sort Examples:**
- `sort=-createdAt` → Sort by created date, newest first
- `sort=basePrice` → Sort by price, lowest first
- `sort=-averageRating,name` → Sort by rating desc, then name asc

### Filter Parameters

| Filter | Operator | Example | Description |
|--------|----------|---------|-------------|
| `category` | eq | `?category=electronics` | Filter by category |
| `style` | eq | `?style=street` | Filter by style enum |
| `tags` | eq | `?tags=wireless` | Filter by tag |
| `basePrice[gte]` | gte | `?basePrice[gte]=100` | Price >= 100 |
| `basePrice[lte]` | lte | `?basePrice[lte]=500` | Price <= 500 |
| `averageRating[gte]` | gte | `?averageRating[gte]=4` | Rating >= 4 |
| `quantity[gt]` | gt | `?quantity[gt]=0` | In stock only |

**Available Operators:**
- `eq` - Equals (default, can be omitted)
- `ne` - Not equals
- `gt` - Greater than
- `gte` - Greater than or equal
- `lt` - Less than
- `lte` - Less than or equal
- `in` - In array
- `nin` - Not in array
- `contains` / `like` - Regex match (case-insensitive)

**Filter Syntax:**
```
?field=value                    # Equals
?field[operator]=value          # With operator
?field[gte]=100&field[lte]=500  # Range
```

### Search Parameter

| Parameter | Type | Description |
|-----------|------|-------------|
| `search` | string | Full-text search across name, description, tags |

**Example:**
```
?search=wireless headphones
```

**Note:** Requires text index on `name`, `description`, `tags` (already configured)

### Other Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `select` | string | Space or comma-separated fields to select |
| `lean` | boolean | Return plain objects instead of Mongoose documents (default: true) |
| `populate` | - | Not supported (images are plain URLs) |

---

## Response Formats

### Pagination Response Formats

#### Offset Pagination Response
```json
{
  "success": true,
  "method": "offset",
  "docs": [
    { /* Product 1 */ },
    { /* Product 2 */ },
    { /* ... */ }
  ],
  "total": 1523,
  "pages": 77,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

#### Keyset Pagination Response
```json
{
  "success": true,
  "method": "keyset",
  "docs": [
    { /* Product 1 */ },
    { /* Product 2 */ },
    { /* ... */ }
  ],
  "limit": 20,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0IjoiZGF0ZSIsInYiOiIyMDI1LTEyLTA1VDAwOjAwOjAwLjAwMFoiLCJpIjoiNTA3ZjFmNzdiY2Y4NmNkNzk5NDM5MDExIn0"
}
```

---

## Examples

### Frontend Quick Usage (copy/paste)

| Use case | Request | Notes |
|----------|---------|-------|
| Featured grid (FE-controlled) | `GET /api/products?tags=featured&limit=8&sort=-createdAt` | Treat `tags=featured` as the flag. |
| Best sellers | `GET /api/products?sort=-stats.totalSales&limit=8` | Uses sales stats to surface popular items. |
| Category page | `GET /api/products?category=electronics&page=1&limit=24&sort=-createdAt` | Uses offset pagination for SEO-friendly pages. |
| Category + price range | `GET /api/products?category=electronics&basePrice[gte]=100&basePrice[lte]=500&sort=basePrice&page=1&limit=24` | Range filter for sliders. |
| Highly rated | `GET /api/products?averageRating[gte]=4&limit=12&sort=-averageRating` | Only returns items with rating >= 4. |
| Search box | `GET /api/products?search=wireless%20headphones&limit=12` | Full-text search across name/description/tags. |
| Product detail (with images) | `GET /api/products/:id` | Images include `variants.thumbnail`/`variants.medium` URLs for fast rendering. |
| Recommendations widget | `GET /api/products/:productId/recommendations` | Returns up to 4 related items (same category, by sales). |

### Example 1: Simple Product Listing (Offset Pagination)

**Request:**
```http
GET /api/products?page=1&limit=20
```

**Response:**
```json
{
  "success": true,
  "method": "offset",
  "docs": [ /* 20 products */ ],
  "total": 150,
  "pages": 8,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

---

### Example 2: Infinite Scroll (Keyset Pagination)

**First Load:**
```http
GET /api/products?limit=20&sort=-createdAt
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* 20 products */ ],
  "limit": 20,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0IjoiZGF0ZSIsInYiOiIyMDI1..."
}
```

**Load More (User Scrolls):**
```http
GET /api/products?after=eyJ2IjoxLCJ0IjoiZGF0ZSIsInYiOiIyMDI1...&limit=20&sort=-createdAt
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* Next 20 products */ ],
  "limit": 20,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0IjoiZGF0ZSIsInYiOiIyMDI1..."
}
```

---

### Example 3: Filter by Category

**Request:**
```http
GET /api/products?category=electronics&page=1&limit=20
```

**Response:**
```json
{
  "success": true,
  "method": "offset",
  "docs": [ /* Electronics products */ ],
  "total": 45,
  "pages": 3,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

---

### Example 4: Filter by Price Range

**Request:**
```http
GET /api/products?basePrice[gte]=100&basePrice[lte]=500&page=1
```

**Response:**
```json
{
  "success": true,
  "method": "offset",
  "docs": [ /* Products between $100-$500 */ ],
  "total": 78,
  "pages": 4,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

---

### Example 5: Full-Text Search

**Request:**
```http
GET /api/products?search=wireless headphones&limit=20
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* Products matching search */ ],
  "limit": 20,
  "hasMore": false,
  "next": null
}
```

---

### Example 6: Complex Query

**Request:**
```http
GET /api/products?category=electronics&basePrice[lte]=300&averageRating[gte]=4&sort=-averageRating&page=1&limit=10
```

**Description:** Electronics under $300 with rating >= 4, sorted by rating

**Response:**
```json
{
  "success": true,
  "method": "offset",
  "docs": [ /* Filtered and sorted products */ ],
  "total": 23,
  "pages": 3,
  "page": 1,
  "limit": 10,
  "hasNext": true,
  "hasPrev": false
}
```

---

### Example 7: Get Trending Products

**Request:**
```http
GET /api/products?sort=-stats.totalSales&limit=10
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* Top 10 best-selling products */ ],
  "limit": 10,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0Ijoi..."
}
```

---

### Example 8: Get New Arrivals

**Request:**
```http
GET /api/products?sort=-createdAt&limit=10
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* 10 newest products */ ],
  "limit": 10,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0Ijoi..."
}
```

---

### Example 9: Get Discounted Products

**Request:**
```http
GET /api/products?discount.startDate[lte]=2025-12-05&discount.endDate[gte]=2025-12-05&sort=-discount.value&limit=20
```

**Description:** Products with active discounts, sorted by discount value

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* Discounted products */ ],
  "limit": 20,
  "hasMore": false,
  "next": null
}
```

---

### Example 10: Get Top Rated Products

**Request:**
```http
GET /api/products?numReviews[gte]=1&sort=-averageRating&limit=10
```

**Response:**
```json
{
  "success": true,
  "method": "keyset",
  "docs": [ /* Top rated products */ ],
  "limit": 10,
  "hasMore": true,
  "next": "eyJ2IjoxLCJ0Ijoi..."
}
```

---

## Frontend Integration Examples

### React - Infinite Scroll

```javascript
import { useState, useEffect } from 'react';

function ProductList() {
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadProducts = async () => {
    if (loading || !hasMore) return;

    setLoading(true);
    const url = cursor
      ? `/api/products?after=${cursor}&limit=20&sort=-createdAt`
      : `/api/products?limit=20&sort=-createdAt`;

    const response = await fetch(url);
    const data = await response.json();

    setProducts(prev => [...prev, ...data.docs]);
    setCursor(data.next);
    setHasMore(data.hasMore);
    setLoading(false);
  };

  useEffect(() => {
    loadProducts();
  }, []);

  return (
    <div>
      {products.map(product => (
        <ProductCard key={product._id} product={product} />
      ))}
      {hasMore && (
        <button onClick={loadProducts} disabled={loading}>
          {loading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}
```



---

## Performance Tips

### 1. Use Keyset Pagination for Large Datasets

For collections with millions of documents or deep pagination:

```http
# ❌ Slow for large offsets
GET /api/products?page=1000&limit=50

# ✅ Fast regardless of position
GET /api/products?after=eyJ2IjoxLC...&limit=50&sort=-createdAt
```

### 2. Required Indexes

The following indexes are already configured in the Product model:

```javascript
// For keyset pagination
{ createdAt: -1, _id: -1 }

// For category filtering
{ category: 1 }

// For full-text search
{ name: 'text', description: 'text', tags: 'text' }
```

### 3. Limit Response Size

Use `select` to fetch only needed fields:

```http
GET /api/products?select=name,basePrice,images&limit=20
```

### 4. Cache Strategy

- List endpoints support caching
- Use `cache-control` headers
- Invalidate cache on product updates

---

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Validation error",
  "details": {
    "name": "Name is required",
    "basePrice": "Base price must be a positive number"
  }
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "error": "Authentication required"
}
```

### 403 Forbidden
```json
{
  "success": false,
  "error": "Insufficient permissions"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Product not found"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Internal server error",
  "message": "An unexpected error occurred"
}
```

---

## Notes

### Auto-Filtering
- Only active products (`isActive: true`) are returned by default
- Use `includeInactive: true` option (internal) to include inactive products

### View Count Tracking
- Product view count is automatically incremented when fetching by ID
- Fire-and-forget operation (doesn't affect response time)

### Product Virtuals
The following virtual fields are computed and included in responses:
- `isDiscountActive`: Boolean indicating if discount is currently active
- `currentPrice`: Calculated price after discount (applies discount if active)
- `profitMargin`: Profit per unit (currentPrice - costPrice), null if costPrice not set
- `profitMarginPercent`: Profit percentage ((margin / currentPrice) * 100)
- `featuredImage`: The featured image or first image
- `totalSales`: Total sales count from stats

### Role-Based Field Filtering
**Cost Price Visibility (Admin/Store-Manager Only):**
- `costPrice`, `profitMargin`, `profitMarginPercent` fields are **only visible to admin/store-manager roles**
- Public API responses automatically exclude these fields for security
- Applies to both Product and Variant cost fields

### Slug Generation
- Product slugs are auto-generated from the product name
- Globally unique
- Lowercase, hyphenated format

---


**Last Updated:** 2025-12-06
