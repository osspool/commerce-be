# Category API Guide

Categories use **slug-based references** for optimal query performance. Products store the category slug as a string, enabling direct MongoDB queries without `$lookup`.

---

## Base URL

```
/api/v1/categories
```

---

## Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/categories` | Public | List all (paginated) |
| `GET` | `/categories/tree` | Public | **Nested tree (cache this!)** |
| `GET` | `/categories/:id` | Public | Get by ID |
| `GET` | `/categories/slug/:slug` | Public | Get by slug |
| `POST` | `/categories` | Admin | Create category |
| `PATCH` | `/categories/:id` | Admin | Update category |
| `DELETE` | `/categories/:id` | Admin | Delete (fails if products exist) |

---

## Category Tree

**The main endpoint. FE should cache this and derive everything else from it.**

```http
GET /api/v1/categories/tree
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "slug": "clothing",
      "name": "Clothing",
      "vatRate": null,
      "productCount": 100,
      "children": [
        {
          "slug": "t-shirts",
          "name": "T-Shirts",
          "vatRate": 15,
          "productCount": 42,
          "children": []
        }
      ]
    },
    {
      "slug": "food",
      "name": "Food",
      "vatRate": 5,
      "productCount": 200,
      "children": []
    }
  ]
}
```

### Frontend Helpers

```typescript
// Get children of a category
function getChildren(tree, parentSlug) {
  for (const node of tree) {
    if (node.slug === parentSlug) return node.children;
    const found = getChildren(node.children, parentSlug);
    if (found) return found;
  }
  return null;
}

// Flatten for dropdowns
function flattenTree(nodes, depth = 0, result = []) {
  for (const n of nodes) {
    result.push({ ...n, depth, displayName: '  '.repeat(depth) + n.name });
    if (n.children) flattenTree(n.children, depth + 1, result);
  }
  return result;
}

// Find category by slug
function findBySlug(tree, slug) {
  for (const node of tree) {
    if (node.slug === slug) return node;
    const found = findBySlug(node.children, slug);
    if (found) return found;
  }
  return null;
}
```

---

## Get by Slug

**For URL resolution when you need full category details.**

```http
GET /api/v1/categories/slug/t-shirts
```

---

## VAT Rate Configuration

Categories support **category-level VAT rates** as part of the 3-tier VAT cascade system (Product → Category → Platform).

### How Category VAT Works

Categories can define default VAT rates for all products within that category:

```json
POST /api/v1/categories
{
  "name": "Food",
  "slug": "food",
  "vatRate": 5  // All food products default to 5% VAT
}
```

**VAT Resolution:**
1. Products in this category inherit the 5% rate (unless they have their own `vatRate` override)
2. If category `vatRate = null`, products inherit from platform default (typically 15%)
3. Products can override with their own `product.vatRate` field

### Common Category VAT Rates (Bangladesh)

| Category | VAT Rate | Example |
|----------|----------|---------|
| Food | `5%` | Rice, flour, basic groceries |
| Electronics | `15%` | Phones, laptops (standard rate) |
| Books | `0%` | Educational materials (exempt) |
| Clothing | `15%` | Standard retail rate |
| Medicine | `0%` or `5%` | Depends on essential vs non-essential |

### Examples

**Set reduced rate for food:**
```json
POST /api/v1/categories
{
  "name": "Food",
  "vatRate": 5
}
```

**Exempt category (educational materials):**
```json
POST /api/v1/categories
{
  "name": "Books",
  "vatRate": 0
}
```

**Use platform default:**
```json
POST /api/v1/categories
{
  "name": "Electronics",
  "vatRate": null  // Uses platform default (15%)
}
```

**Update category VAT:**
```http
PATCH /api/v1/categories/:id
{
  "vatRate": 7.5  // Change to new rate
}
```

### Notes

- ✅ Category VAT rates apply to all products unless overridden at product level
- ✅ `null` means "use platform default" (typically 15%)
- ✅ `0` means "exempt from VAT"
- ✅ Products can override category rate with `product.vatRate`
- ✅ Variants can override product rate with `variant.vatRate`
- ⚠️ Changing category VAT doesn't affect historical orders (rates are snapshot at checkout)

---

## Create Category

```http
POST /api/v1/categories
Authorization: Bearer <admin_token>
```

```json
{
  "name": "T-Shirts",
  "parent": "clothing",
  "description": "Cool t-shirts",
  "vatRate": null
}
```

**Fields:**
- `name` (required): Display name
- `parent` (optional): Parent category **slug** (not ObjectId)
- `description` (optional): Short description
- `image` (optional): Category image { url, alt }
- `displayOrder` (optional): Sort order (lower = first)
- `vatRate` (optional): VAT rate override (0-100). `null` = use platform default
- `isActive` (optional): Visibility toggle (default: true)

**Auto-Generated:**
- `slug` - Auto-generated from `name` (immutable)
- `productCount` - Maintained automatically by product events

---

## Update Category

```http
PATCH /api/v1/categories/:id
```

> Slug cannot be changed.

---

## Delete Category

```http
DELETE /api/v1/categories/:id
```

**Fails if products exist.** Move products first.

---

## Summary

| Need | Solution |
|------|----------|
| Navigation menu | `getTree()` → render recursively |
| Admin dropdown | `getTree()` → `flattenTree()` |
| Get children | `getTree()` → `getChildren(tree, slug)` |
| URL resolution | `getBySlug()` or `findBySlug(tree, slug)` |
| Filter products | `productApi.getAll({ params: { category: slug } })` |

**One tree endpoint. FE does the rest.** 🎯

---

## VAT Integration with Products

When creating/updating products, they automatically inherit category VAT rates:

**Example Flow:**

1. **Create food category with 5% VAT:**
```http
POST /api/v1/categories
{
  "name": "Food",
  "vatRate": 5
}
```

2. **Create product in food category (inherits 5%):**
```http
POST /api/v1/products
{
  "name": "Rice (Miniket)",
  "category": "food",
  "basePrice": 65
  // vatRate: null → inherits category's 5%
}
```

3. **Override for specific product:**
```http
POST /api/v1/products
{
  "name": "Organic Rice (Premium)",
  "category": "food",
  "basePrice": 120,
  "vatRate": 7.5  // Overrides category's 5%
}
```

**See Also:** [Product API - VAT Rate Configuration](product.md#vat-rate-configuration) for full 3-tier cascade details.

---

**Last Updated:** 2025-12-21
