# Size Guide API Guide

Quick reference for managing size guide templates with dynamic measurements.

> **Note:** Size guides are templates that can be referenced by products to display size information.

---

## Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/size-guides` | Public | List all size guides |
| `GET` | `/api/v1/size-guides/:id` | Public | Get size guide by ID |
| `GET` | `/api/v1/size-guides/slug/:slug` | Public | Get size guide by slug |
| `POST` | `/api/v1/size-guides` | Admin | Create size guide |
| `PATCH` | `/api/v1/size-guides/:id` | Admin | Update size guide |
| `DELETE` | `/api/v1/size-guides/:id` | Admin | Delete size guide |

---

## List Size Guides

```http
GET /api/v1/size-guides?page=1&limit=20
```

### Query Parameters

| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 50, max: 100) |
| `sort` | string | Sort field (default: `displayOrder,name`) |
| `isActive` | boolean | Filter by active status |
| `name` | string | Filter by exact name match |
| `name[contains]` | string | Filter by partial name match |
| `slug` | string | Filter by exact slug match |

### Examples

**List all active size guides:**
```http
GET /api/v1/size-guides
```

**Search by name:**
```http
GET /api/v1/size-guides?name[contains]=shirt
```

**Get inactive size guides:**
```http
GET /api/v1/size-guides?isActive=false
```

### Response

```json
{
  "success": true,
  "docs": [
    {
      "_id": "size_guide_id",
      "name": "T-Shirts & Tops",
      "slug": "t-shirts-tops",
      "description": "Size guide for t-shirts and tops",
      "measurementUnit": "inches",
      "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
      "sizes": [
        {
          "name": "XS",
          "measurements": {
            "chest": "34-36",
            "length": "26",
            "shoulder": "16",
            "sleeve": "7.5"
          }
        },
        {
          "name": "S",
          "measurements": {
            "chest": "36-38",
            "length": "27",
            "shoulder": "17",
            "sleeve": "8"
          }
        }
      ],
      "note": "All measurements are in inches. For the best fit, measure a similar garment that fits you well.",
      "isActive": true,
      "displayOrder": 1,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-15T00:00:00.000Z"
    }
  ],
  "total": 5,
  "page": 1,
  "pages": 1,
  "hasNext": false,
  "hasPrev": false,
  "limit": 50
}
```

---

## Get Size Guide by ID

```http
GET /api/v1/size-guides/:id
```

### Response

```json
{
  "success": true,
  "data": {
    "_id": "size_guide_id",
    "name": "T-Shirts & Tops",
    "slug": "t-shirts-tops",
    "description": "Size guide for t-shirts and tops",
    "measurementUnit": "inches",
    "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
    "sizes": [
      {
        "name": "XS",
        "measurements": {
          "chest": "34-36",
          "length": "26",
          "shoulder": "16",
          "sleeve": "7.5"
        }
      },
      {
        "name": "S",
        "measurements": {
          "chest": "36-38",
          "length": "27",
          "shoulder": "17",
          "sleeve": "8"
        }
      },
      {
        "name": "M",
        "measurements": {
          "chest": "38-40",
          "length": "28",
          "shoulder": "18",
          "sleeve": "8.5"
        }
      }
    ],
    "note": "All measurements are in inches. For the best fit, measure a similar garment that fits you well.",
    "isActive": true,
    "displayOrder": 1,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-15T00:00:00.000Z"
  }
}
```

---

## Get Size Guide by Slug

Used for product detail pages to fetch the appropriate size guide.

```http
GET /api/v1/size-guides/slug/:slug
```

### Example

```http
GET /api/v1/size-guides/slug/t-shirts-tops
```

### Response

Same as "Get Size Guide by ID" response.

---

## Create Size Guide

```http
POST /api/v1/size-guides
Authorization: Bearer <admin_token>
```

### Request Body

```json
{
  "name": "T-Shirts & Tops",
  "slug": "t-shirts-tops",
  "description": "Size guide for t-shirts and tops",
  "measurementUnit": "inches",
  "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
  "sizes": [
    {
      "name": "XS",
      "measurements": {
        "chest": "34-36",
        "length": "26",
        "shoulder": "16",
        "sleeve": "7.5"
      }
    },
    {
      "name": "S",
      "measurements": {
        "chest": "36-38",
        "length": "27",
        "shoulder": "17",
        "sleeve": "8"
      }
    },
    {
      "name": "M",
      "measurements": {
        "chest": "38-40",
        "length": "28",
        "shoulder": "18",
        "sleeve": "8.5"
      }
    },
    {
      "name": "L",
      "measurements": {
        "chest": "40-42",
        "length": "29",
        "shoulder": "19",
        "sleeve": "9"
      }
    },
    {
      "name": "XL",
      "measurements": {
        "chest": "42-44",
        "length": "30",
        "shoulder": "20",
        "sleeve": "9.5"
      }
    },
    {
      "name": "XXL",
      "measurements": {
        "chest": "44-46",
        "length": "31",
        "shoulder": "21",
        "sleeve": "10"
      }
    }
  ],
  "note": "All measurements are in inches. For the best fit, measure a similar garment that fits you well.",
  "isActive": true,
  "displayOrder": 1
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Size guide name (max 100 chars) |
| `slug` | string | No | URL-friendly slug (auto-generated if not provided) |
| `description` | string | No | Size guide description (max 500 chars) |
| `measurementUnit` | string | No | Unit: `inches` or `cm` (default: `inches`) |
| `measurementLabels` | string[] | No | Array of measurement labels (max 10) |
| `sizes` | object[] | No | Array of size definitions |
| `sizes[].name` | string | Yes | Size name (e.g., "XS", "S", "M") |
| `sizes[].measurements` | object | No | Key-value pairs of measurements |
| `note` | string | No | Additional notes (max 1000 chars) |
| `isActive` | boolean | No | Active status (default: `true`) |
| `displayOrder` | number | No | Display order (default: `0`) |

### Slug Auto-Generation

If `slug` is not provided, it will be auto-generated from `name`:
- Converts to lowercase
- Replaces spaces with hyphens
- Removes special characters

Example: `"T-Shirts & Tops"` → `"t-shirts-tops"`

### Response

```json
{
  "success": true,
  "data": {
    "_id": "size_guide_id",
    "name": "T-Shirts & Tops",
    "slug": "t-shirts-tops",
    ...
  }
}
```

---

## Update Size Guide

```http
PATCH /api/v1/size-guides/:id
Authorization: Bearer <admin_token>
```

### Request Body

All fields are optional. Only include fields you want to update.

```json
{
  "name": "T-Shirts, Tops & Polos",
  "description": "Updated description",
  "sizes": [
    {
      "name": "XS",
      "measurements": {
        "chest": "34-36",
        "length": "26",
        "shoulder": "16",
        "sleeve": "7.5"
      }
    },
    {
      "name": "S",
      "measurements": {
        "chest": "36-38",
        "length": "27",
        "shoulder": "17",
        "sleeve": "8"
      }
    }
  ],
  "isActive": true
}
```

### Updating Sizes

When updating `sizes` array, you must provide the **complete** array of sizes. The existing sizes will be replaced entirely.

### Response

```json
{
  "success": true,
  "data": {
    "_id": "size_guide_id",
    "name": "T-Shirts, Tops & Polos",
    ...
  }
}
```

---

## Delete Size Guide

```http
DELETE /api/v1/size-guides/:id
Authorization: Bearer <admin_token>
```

> **Warning:** Deleting a size guide does not affect products that reference it. Consider deactivating (`isActive: false`) instead if products are using it.

### Response

```json
{
  "success": true,
  "message": "Document deleted"
}
```

---

## Common Use Cases

### 1. Creating Size Guides for Different Product Types

Create separate size guides for different product categories:

**T-Shirts & Tops:**
```json
{
  "name": "T-Shirts & Tops",
  "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
  "sizes": [...]
}
```

**Pants & Jeans:**
```json
{
  "name": "Pants & Jeans",
  "measurementLabels": ["Waist", "Hip", "Inseam", "Outseam"],
  "sizes": [...]
}
```

**Hoodies & Jackets:**
```json
{
  "name": "Hoodies & Jackets",
  "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
  "sizes": [...]
}
```

### 2. Using Metric Units

For international markets:

```json
{
  "name": "T-Shirts (Metric)",
  "measurementUnit": "cm",
  "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
  "sizes": [
    {
      "name": "XS",
      "measurements": {
        "chest": "86-91",
        "length": "66",
        "shoulder": "41",
        "sleeve": "19"
      }
    }
  ]
}
```

### 3. Flexible Measurement Labels

Create custom measurement labels for any product type:

**Footwear:**
```json
{
  "name": "Shoes",
  "measurementLabels": ["US Size", "EU Size", "UK Size", "Foot Length"],
  "sizes": [
    {
      "name": "US 7",
      "measurements": {
        "us_size": "7",
        "eu_size": "40",
        "uk_size": "6",
        "foot_length": "9.25"
      }
    }
  ]
}
```

**Accessories (Caps/Hats):**
```json
{
  "name": "Caps & Hats",
  "measurementLabels": ["Head Circumference"],
  "sizes": [
    {
      "name": "One Size",
      "measurements": {
        "head_circumference": "21-24"
      }
    }
  ]
}
```

---

## Product Integration

Products can optionally reference a size guide to display sizing information on product pages.

### Adding Size Guide to Product

When creating or updating a product, include the `sizeGuide` field with the size guide's `_id`:

```http
POST /api/v1/products
Authorization: Bearer <admin_token>
```

```json
{
  "name": "Classic Cotton T-Shirt",
  "category": "t-shirts",
  "basePrice": 799,
  "sizeGuide": "676a3f8b9c123456789abcde",
  ...
}
```

### Fetching Product with Size Guide

Use the `populate` query parameter to include the size guide data:

```http
GET /api/v1/products/:id?populate=sizeGuide
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "product_id",
    "name": "Classic Cotton T-Shirt",
    "category": "t-shirts",
    "basePrice": 799,
    "sizeGuide": {
      "_id": "676a3f8b9c123456789abcde",
      "name": "T-Shirts & Tops",
      "slug": "t-shirts-tops",
      "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
      "sizes": [
        {
          "name": "S",
          "measurements": {
            "chest": "36-38",
            "length": "27",
            "shoulder": "17",
            "sleeve": "8"
          }
        }
      ]
    }
  }
}
```

### Listing Products by Size Guide

Filter products that use a specific size guide:

```http
GET /api/v1/products?sizeGuide=676a3f8b9c123456789abcde
```

### Removing Size Guide from Product

Set `sizeGuide` to `null`:

```http
PATCH /api/v1/products/:id
Authorization: Bearer <admin_token>
```

```json
{
  "sizeGuide": null
}
```

---

## Frontend Integration

### 1. Listing Size Guides (Admin Panel)

```javascript
// Fetch all size guides
const res = await fetch('/api/v1/size-guides');
const { docs } = await res.json();

// Display in dropdown
<select>
  {docs.map(guide => (
    <option key={guide._id} value={guide._id}>
      {guide.name}
    </option>
  ))}
</select>
```

### 2. Displaying Size Guide on Product Page

```javascript
// Option 1: Fetch product with populated size guide
const res = await fetch(`/api/v1/products/${productId}?populate=sizeGuide`);
const { data: product } = await res.json();
const sizeGuide = product.sizeGuide;

// Option 2: Fetch size guide separately if you only have the ID
const sizeGuideRes = await fetch(`/api/v1/size-guides/${product.sizeGuide}`);
const { data: sizeGuide } = await sizeGuideRes.json();

// Display size table
<table>
  <thead>
    <tr>
      <th>Size</th>
      {sizeGuide.measurementLabels.map(label => (
        <th key={label}>{label}</th>
      ))}
    </tr>
  </thead>
  <tbody>
    {sizeGuide.sizes.map(size => (
      <tr key={size.name}>
        <td>{size.name}</td>
        {sizeGuide.measurementLabels.map(label => {
          const key = label.toLowerCase().replace(/\s+/g, '_');
          return <td key={key}>{size.measurements[key] || '-'}</td>;
        })}
      </tr>
    ))}
  </tbody>
</table>
```

### 3. Size Guide Modal/Popup

```javascript
// Show size guide in modal when user clicks "Size Guide" button
function SizeGuideModal({ sizeGuide }) {
  return (
    <div className="modal">
      <h3>{sizeGuide.name}</h3>
      {sizeGuide.description && <p>{sizeGuide.description}</p>}

      <table className="size-table">
        {/* Size table as shown above */}
      </table>

      {sizeGuide.note && (
        <p className="note">{sizeGuide.note}</p>
      )}

      <p className="unit">
        All measurements are in {sizeGuide.measurementUnit}.
      </p>
    </div>
  );
}
```

---

## TypeScript Types

```typescript
interface SizeGuide {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  measurementUnit: 'inches' | 'cm';
  measurementLabels: string[];
  sizes: Size[];
  note?: string;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

interface Size {
  name: string;
  measurements: Record<string, string>;
}

// Example
const tShirtGuide: SizeGuide = {
  _id: "123",
  name: "T-Shirts & Tops",
  slug: "t-shirts-tops",
  measurementUnit: "inches",
  measurementLabels: ["Chest", "Length", "Shoulder", "Sleeve"],
  sizes: [
    {
      name: "S",
      measurements: {
        chest: "36-38",
        length: "27",
        shoulder: "17",
        sleeve: "8"
      }
    }
  ],
  isActive: true,
  displayOrder: 1,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01")
};
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
| 400 | Validation error, slug already exists, invalid measurement unit |
| 401 | Not authenticated (for create/update/delete) |
| 403 | Access denied (non-admin trying to create/update/delete) |
| 404 | Size guide not found |

---

## Best Practices

1. **Slug Management:**
   - Let the system auto-generate slugs from names
   - Only provide custom slug if you need specific URL structure
   - Slugs are used for SEO-friendly URLs (e.g., `/size-guides/slug/t-shirts-tops`)

2. **Measurement Labels:**
   - Use consistent naming across size guides (e.g., always "Chest" not "chest" or "Bust")
   - Keep labels concise (they're used as table headers)
   - Limit to 10 labels maximum for readability

3. **Size Definitions:**
   - Always include measurement ranges (e.g., "34-36") rather than single values
   - Be consistent with measurement format across all sizes
   - Measurement object keys should match label names (lowercase, underscored)

4. **Active Status:**
   - Use `isActive: false` instead of deleting size guides
   - Inactive guides won't show in public listings but remain accessible by ID/slug

5. **Display Order:**
   - Use `displayOrder` to control how size guides appear in admin dropdowns
   - Lower numbers appear first (e.g., 1, 2, 3...)

6. **Notes:**
   - Add measurement instructions (e.g., "Measure across the chest at the widest point")
   - Include fit information (e.g., "This style runs small, consider sizing up")

7. **Product Integration:**
   - Products reference size guides by `_id` (ObjectId), not slug
   - One size guide can be reused across multiple products
   - Use `populate=sizeGuide` when fetching products to get full size guide data
   - Don't delete size guides that are actively used by products - deactivate instead

---

## Migration from Static to Dynamic

If you're migrating from hardcoded size tables:

**Before (hardcoded in frontend):**
```javascript
const tshirtSizes = {
  XS: { chest: "34-36", length: "26" },
  S: { chest: "36-38", length: "27" }
};
```

**After (dynamic from API):**
```javascript
// 1. Create size guide via API
POST /api/v1/size-guides
{
  "name": "T-Shirts & Tops",
  "measurementLabels": ["Chest", "Length", "Shoulder", "Sleeve"],
  "sizes": [...]
}
// Returns: { success: true, data: { _id: "676a3f8b...", ... } }

// 2. Store size guide ID in product
PATCH /api/v1/products/:id
{
  "sizeGuide": "676a3f8b9c123456789abcde"
}

// 3. Fetch product with populated size guide on product page
GET /api/v1/products/:id?populate=sizeGuide
// Returns product with full size guide data embedded
```

Benefits:
- Update size information without code deployment
- Reuse same size guide across multiple products
- Support multiple measurement systems
- Easy A/B testing of size recommendations
