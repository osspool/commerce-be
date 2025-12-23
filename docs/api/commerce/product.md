# Product API Guide

Complete guide to the Product API endpoints with pagination, filtering, and search capabilities.

## Table of Contents
- [Base URL](#base-url)
- [Authentication](#authentication)
- [Variants Quick Reference](#variants-quick-reference)
- [Cost Price (COGS)](#cost-price-cogs)
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
| Restore Product | Yes | `admin` |
| Get Deleted Products | Yes | `admin` |

---

## Variants Quick Reference

All variant operations use standard CRUD endpoints - no special APIs needed.

### When to Show Variant Selectors (FE Rules)

- Show variant UI only when `product.productType === "variant"` **and** `product.variants.length > 0`.
- For simple products (`product.productType === "simple"`), **do not** send `variantSku` in cart/order payloads.
- If `product.productType === "variant"` but `variants` is empty, treat it as a backend data issue and block add‑to‑cart (show a message).
- To convert a simple product into a variant product, **PATCH** with `variationAttributes` (and optionally `variants`). `productType` will auto‑switch based on the updated data.

| Operation | Method | Endpoint | Payload |
|-----------|--------|----------|---------|
| Create with variants | `POST` | `/products` | `{ variationAttributes, variants }` |
| Add variant options | `PATCH` | `/products/:id` | `{ variationAttributes }` (add values) |
| Remove variant options | `PATCH` | `/products/:id` | `{ variationAttributes }` (remove values) |
| Update variant price/barcode | `PATCH` | `/products/:id` | `{ variants: [{ sku, priceModifier }] }` |
| Disable a variant | `PATCH` | `/products/:id` | `{ variants: [{ sku, isActive: false }] }` |

> **Note:** Variants are never deleted - they're marked `isActive: false` to preserve order history.

**Example - Create T-Shirt with Size/Color:**
```json
POST /api/v1/products
{
  "name": "Cotton T-Shirt",
  "basePrice": 500,
  "quantity": 0,
  "category": "clothing",
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M", "L"] },
    { "name": "Color", "values": ["Red", "Blue"] }
  ]
}
```
→ Backend auto-generates 6 variants: S-Red, S-Blue, M-Red, M-Blue, L-Red, L-Blue

**Example - Remove "L" size (marks L variants as inactive):**
```json
PATCH /api/v1/products/:id
{
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M"] },
    { "name": "Color", "values": ["Red", "Blue"] }
  ]
}
```
→ L-Red and L-Blue become `isActive: false`

**Example - Update variant price:**
```json
PATCH /api/v1/products/:id
{
  "variants": [{ "sku": "COTTONTSHIRT-L-RED", "priceModifier": 50 }]
}
```

---

## Barcode Support

Products support **optional barcodes** at multiple levels for POS scanning and inventory management.

### Barcode Levels

| Product Type | Barcode Location | Usage |
|--------------|------------------|-------|
| Simple Product | `product.barcode` | Single scannable barcode |
| Variant Product | `variants[].barcode` | Per-variant barcode (e.g., S-Red has unique barcode) |

### Adding Barcodes (Optional Field)

**Simple Product:**
```json
POST /api/v1/products
{
  "name": "Wireless Mouse",
  "sku": "MOUSE-001",
  "barcode": "1234567890123",  // ← Optional: Add EAN-13, UPC, or custom
  "basePrice": 300,
  "category": "electronics"
}
```

**Variant Product:**
```json
POST /api/v1/products
{
  "name": "T-Shirt",
  "basePrice": 500,
  "category": "clothing",
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M", "L"] },
    { "name": "Color", "values": ["Red", "Blue"] }
  ],
  "variants": [
    {
      "attributes": { "size": "S", "color": "Red" },
      "barcode": "8901234567890"  // ← Optional: Add per-variant barcode
    },
    {
      "attributes": { "size": "M", "color": "Red" },
      "barcode": "8901234567891"
    }
  ]
}
```

### Updating Barcodes

**Update simple product barcode:**
```json
PATCH /api/v1/products/:id
{
  "barcode": "NEW-BARCODE-123"
}
```

**Update variant barcodes:**
```json
PATCH /api/v1/products/:id
{
  "variants": [
    { "sku": "TSHIRT-S-RED", "barcode": "8901234567890" },
    { "sku": "TSHIRT-M-RED", "barcode": "8901234567891" }
  ]
}
```

### POS Barcode Scanning

Use the POS lookup API to scan barcodes:

```http
GET /api/v1/pos/lookup?code=8901234567890&branchId=xxx
```

See [POS API Guide](pos.md#2-barcode-lookup) for details.

---

## Cost Price (COGS)

`costPrice` is your **Cost of Goods Sold** used for margin/profit reporting. It is **role-restricted** (see “Role-Based Field Filtering” below).

### Where to set `costPrice`

**Standard (recommended / single source of truth): Head Office Inventory**

- Set cost price via **Head Office purchases** (`POST /api/v1/inventory/purchases` with `items[].costPrice`).
- Backend stores the true cost on **Head Office stock** (`StockEntry.costPrice`) and keeps a **read-only snapshot** on:
  - `product.costPrice` (simple products)
  - `variants[].costPrice` (variant products)

This keeps cost changes auditable (StockMovement) and ensures all branches inherit costs through transfers.

### Cost Price Management Strategy

For a healthy business, **Profit Analysis** is critical. Here is the recommended workflow:

1.  **Inventory-First Approach (Best Practice):**
    *   **Do not** manually edit `costPrice` on products.
    *   Instead, record **Purchases** in the Inventory system.
    *   The system automatically calculates the **Weighted Average Cost** and updates the product snapshot.
    *   *Why?* This ensures your accounting matches your physical stock history.

2.  **Manual Override (Correction Only):**
    *   If a cost is wrong (e.g. data entry error), an Admin can manually PATCH `product.costPrice`.
    *   *Warning:* This desynchronizes the product from its inventory purchase history. Use sparingly.

3.  **Role-Based Visibility:**
    *   `product.costPrice` is a sensitive field.
    *   The API automatically hides this field for non-privileged roles (e.g. `store-manager` might see it, but `staff` might not, depending on permissions).
    *   **Frontend Rule:** If `costPrice` is missing in the response, do not display "0". Assume "Hidden".

### Barcode Generation (Frontend)

**Option 1: Use a library to generate valid barcodes**

```bash
npm install ean13-lib bwip-js
```

```javascript
import { generateEAN13 } from 'ean13-lib';
import bwipjs from 'bwip-js';

// Generate EAN-13 barcode
function generateProductBarcode(productSku) {
  // Generate check digit automatically
  return generateEAN13(productSku.slice(-12).padStart(12, '0'));
}

// Generate barcode image for printing
async function generateBarcodeImage(barcode) {
  const canvas = document.createElement('canvas');
  await bwipjs.toCanvas(canvas, {
    bcid: 'ean13',        // Barcode type
    text: barcode,        // Barcode value
    scale: 3,             // Scaling factor
    height: 10,           // Bar height in mm
    includetext: true,    // Show human-readable text
    textxalign: 'center'
  });
  return canvas.toDataURL('image/png');
}

// Usage in product creation
const product = {
  name: "T-Shirt",
  sku: "TSHIRT-001",
  barcode: generateProductBarcode("TSHIRT-001"), // Auto-generated
  // ...
};
```

**Option 2: Let users input barcodes manually**

```jsx
<input
  type="text"
  placeholder="Barcode (optional - EAN-13 format)"
  pattern="[0-9]{13}"
  value={barcode}
  onChange={(e) => setBarcode(e.target.value)}
/>
```

**Option 3: Use barcode scanner hardware**

Most USB barcode scanners work as keyboard input - just focus the barcode input field and scan!

### Barcode Printing

**Generate printable barcode labels:**

```javascript
// Frontend: Generate and print barcode
async function printProductBarcode(product) {
  const barcode = product.barcode || generateProductBarcode(product.sku);
  const barcodeImage = await generateBarcodeImage(barcode);

  // Open print dialog with barcode
  const printWindow = window.open('', '', 'width=400,height=200');
  printWindow.document.write(`
    <html>
      <head>
        <title>Print Barcode - ${product.name}</title>
        <style>
          body { text-align: center; padding: 20px; }
          img { margin: 10px 0; }
        </style>
      </head>
      <body>
        <h3>${product.name}</h3>
        <img src="${barcodeImage}" alt="Barcode" />
        <p>${barcode}</p>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
}
```

### Barcode Validation

**EAN-13 validation:**

```javascript
function validateEAN13(barcode) {
  if (!/^\d{13}$/.test(barcode)) return false;

  const digits = barcode.split('').map(Number);
  const checksum = digits.pop();

  const sum = digits.reduce((acc, digit, i) =>
    acc + digit * (i % 2 === 0 ? 1 : 3), 0
  );

  const calculatedChecksum = (10 - (sum % 10)) % 10;
  return checksum === calculatedChecksum;
}

// Usage
if (barcode && !validateEAN13(barcode)) {
  alert('Invalid EAN-13 barcode');
}
```

### Recommended Libraries

| Library | Purpose | Size |
|---------|---------|------|
| [bwip-js](https://github.com/metafloor/bwip-js) | Generate barcode images (EAN-13, UPC, Code128, QR) | ~200KB |
| [jsbarcode](https://github.com/lindell/JsBarcode) | Lightweight barcode SVG generator | ~50KB |
| [ean13-lib](https://www.npmjs.com/package/ean13-lib) | EAN-13 generation with check digit | ~5KB |
| [barcode-validator](https://www.npmjs.com/package/barcode-validator) | Validate EAN/UPC barcodes | ~10KB |

### Notes

- ✅ Barcodes are **optional** - products work fine without them
- ✅ Globally unique constraint enforced (no duplicate barcodes)
- ✅ Use for POS scanning, warehouse labels, retail packaging
- ✅ Can be added/updated at any time via PATCH
- ⚠️ **Not auto-generated** - frontend must provide or generate

---

## Inventory Quantity (Read Model)

`product.quantity` is a **synced total** across all branches, derived from `StockEntry` records.

- **Source of truth:** `StockEntry` (per branch + variant).
- **Sync:** updated automatically after inventory mutations; can be forced with `POST /api/v1/products/:id/sync-stock`.
- **Variant quantities:** per-branch counts are not stored on the product. Use inventory/branch endpoints when you need branch-level stock.
- **Sync scope:** `sync-stock` recomputes `product.quantity` and `stockProjection.variants`. Branch-level counts remain in `StockEntry`.

## Variant Stock Projection (Read-Only)

For fast storefront availability checks, the backend maintains a **read-only** projection on the product:

```json
{
  "stockProjection": {
    "variants": [
      { "sku": "TSHIRT-M-RED", "quantity": 30 },
      { "sku": "TSHIRT-L-RED", "quantity": 12 }
    ],
    "syncedAt": "2025-12-21T12:00:00.000Z"
  }
}
```

- **Source of truth:** `StockEntry`
- **Updates:** emitted after stock movements (purchase, transfer, adjustment, sale)
- **Scope:** totals are summed across **all branches** (no branch breakdown)
- **Do not write** to this field from FE; it is system-managed.

### Get Branch + Variant Quantities (POS View)

```http
GET /api/v1/pos/products?branchId=BRANCH_ID&limit=20
```

Response includes:
- `branchStock.quantity` (total at that branch)
- `branchStock.variants[]` (per-variant quantities)

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
GET /api/v1/products
```

**Query Parameters:** See [Query Parameters](#query-parameters) section

**Payload size tip (FE-controlled):** API returns full product objects by default. Pass `select` to trim heavy fields, e.g. `?select=name,slug,basePrice,images` or to exclude with `?select=-properties,-variants` for lighter lists.

**Response:** See [Pagination Response Formats](#pagination-response-formats)

---

### Get Product by ID
```http
GET /api/v1/products/:id
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
    "variationAttributes": [],
    "variants": [],
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

### Frontend Display Guide

**How to show variants to users:**

```typescript
// 1. Check if product has variants
if (product.productType === 'variant' && product.variants?.length) {
  // Product has variants - show selector UI

  // 2. Build selectors from variationAttributes
  product.variationAttributes.forEach(attr => {
    // Render dropdown/buttons for each attribute
    // Example: Size selector with ["S", "M", "L"]
    <Select label={attr.name}>
      {attr.values.map(value => (
        <option key={value}>{value}</option>
      ))}
    </Select>
  });

  // 3. When user selects options, find matching variant
  const selectedAttrs = { size: "M", color: "Red" };
  const variant = product.variants.find(v =>
    Object.entries(selectedAttrs).every(([key, val]) =>
      v.attributes[key] === val
    )
  );

  // 4. Calculate final price
  const finalPrice = product.basePrice + (variant?.priceModifier || 0);

  // 5. Add to cart with variantSku
  await addToCart({
    productId: product._id,
    variantSku: variant.sku,  // IMPORTANT: Send variant SKU
    quantity: 1
  });

} else {
  // Simple product - no variant selector needed
  const finalPrice = product.currentPrice || product.basePrice;

  await addToCart({
    productId: product._id,
    // variantSku: null (omit for simple products)
    quantity: 1
  });
}
```

**Variant Product Response Example:**
```json
{
  "productType": "variant",
  "basePrice": 500,
  "vatRate": null,
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M", "L"] },
    { "name": "Color", "values": ["Red", "Blue"] }
  ],
  "variants": [
    {
      "sku": "TSHIRT-S-RED",
      "attributes": { "size": "S", "color": "Red" },
      "priceModifier": 0,
      "vatRate": null,
      "isActive": true
    },
    {
      "sku": "TSHIRT-M-RED",
      "attributes": { "size": "M", "color": "Red" },
      "priceModifier": 0,
      "vatRate": null,
      "isActive": true
    },
    {
      "sku": "TSHIRT-L-RED",
      "attributes": { "size": "L", "color": "Red" },
      "priceModifier": 50,
      "vatRate": 12,
      "isActive": true
    }
    // ... 6 total combinations
  ]
}
```

---

### Get Product by Slug
```http
GET /api/v1/products/slug/:slug
```

**Parameters:**
- `slug` (path, required): Product slug (auto-generated from name)

**Query Parameters:**
- `select`: Space or comma-separated fields to select

**Response:** Same shape as Get by ID.

---

## VAT Rate Configuration

Products support **3-tier VAT cascade** for Bangladesh NBR compliance, enabling product-specific tax rates while maintaining category and platform-level defaults.

### Where VAT Is Defined

- `variants[].vatRate` → per-variant override (most specific)
- `product.vatRate` → per-product override
- `category.vatRate` → category default (`docs/api/commerce/category.md`)
- `platform.vat.defaultRate` → global default (`docs/api/platform.md`)

### VAT Resolution Hierarchy

The system resolves VAT rates in this order (first non-null value wins):

```
1. Variant VAT rate (if variant product)
   ↓
2. Product VAT rate
   ↓
3. Category VAT rate (from Category collection)
   ↓
4. Platform categoryRates (legacy config)
   ↓
5. Platform default rate (15%)
```

**Important:** VAT is only applied when `platform.vat.isRegistered = true`. When disabled, all products get 0% VAT regardless of configured rates.

### VAT Rate Fields

| Level | Field | Location | Use Case |
|-------|-------|----------|----------|
| Variant | `variants[].vatRate` | Product model | Different tax for XL size vs M size |
| Product | `product.vatRate` | Product model | Educational laptop exempt (0%) within electronics category |
| Category | `category.vatRate` | Category model | All food products default to 5% |
| Platform | `platform.vat.defaultRate` | Platform config | Fallback rate (typically 15% for BD) |

### Setting VAT Rates

**Product-Level VAT Override:**
```json
POST /api/v1/products
{
  "name": "Educational Laptop",
  "category": "electronics",
  "basePrice": 45000,
  "vatRate": 0  // Exempt from VAT (overrides category's 15%)
}
```

**Variant-Level VAT Override:**
```json
POST /api/v1/products
{
  "name": "Premium T-Shirt",
  "category": "clothing",
  "basePrice": 500,
  "variationAttributes": [
    { "name": "Size", "values": ["M", "L", "XL"] }
  ],
  "variants": [
    {
      "attributes": { "size": "XL" },
      "priceModifier": 100,
      "vatRate": 10  // XL has different VAT (overrides product/category)
    }
  ]
}
```

**Inherit from Category:**
```json
POST /api/v1/products
{
  "name": "Rice (Miniket)",
  "category": "food",  // Inherits category's 5% VAT
  "basePrice": 65
  // vatRate: null (default) - uses category rate
}
```

### Updating VAT Rates

**Update product VAT:**
```json
PATCH /api/v1/products/:id
{
  "vatRate": 7.5  // Change to reduced rate
}
```

**Update variant VAT:**
```json
PATCH /api/v1/products/:id
{
  "variants": [
    { "sku": "TSHIRT-XL-RED", "vatRate": 12 }
  ]
}
```

**Remove override (inherit from category):**
```json
PATCH /api/v1/products/:id
{
  "vatRate": null  // Now inherits category → platform rate
}
```

### VAT Rate Values

| Rate | Description | Example Products |
|------|-------------|------------------|
| `0` | Exempt | Educational materials, essential medicines |
| `5` | Reduced (Food) | Rice, flour, basic groceries |
| `7.5` | Reduced | Some packaged foods |
| `10` | Reduced | Certain services |
| `15` | Standard | Most goods (default) |
| `null` | Inherit | Use category/platform default |

### Notes

- ✅ All VAT rate fields are optional (`null` = inherit)
- ✅ Rates are snapshot into orders at checkout (audit trail)
- ✅ Changing a product's VAT doesn't affect historical orders
- ✅ VAT only applies when `platform.vat.isRegistered = true`
- ⚠️ Setting `vatRate: 0` is different from `vatRate: null` (0 = exempt, null = inherit)

**See Also:**
- [Category API - VAT Rate Configuration](category.md#vat-rate-configuration) - Set category-level default rates
- [Platform API - VAT Configuration](platform.md) - Configure platform-wide VAT settings

---

### Create Product
```http
POST /api/v1/products
```

**Auth Required:** Yes (admin)

**Request Body (Simple Product):**
```json
{
  "name": "Premium Wireless Headphones",
  "description": "High-quality wireless headphones",
  "basePrice": 299.99,
  "costPrice": 180.00,
  "quantity": 50,
  "category": "electronics",
  "parentCategory": "audio",
  "sku": "HEADPHONES-001",
  "barcode": "1234567890123",
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

**Request Body (Product with Variants):**
```json
{
  "name": "Cotton T-Shirt",
  "description": "Comfortable cotton t-shirt",
  "basePrice": 500,
  "costPrice": 250,
  "quantity": 0,
  "category": "clothing",
  "vatRate": null,
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M", "L", "XL"] },
    { "name": "Color", "values": ["Red", "Blue", "Black"] }
  ],
  "variants": [
    { "attributes": { "size": "L" }, "priceModifier": 50 },
    { "attributes": { "size": "XL" }, "priceModifier": 100, "vatRate": 12 }
  ]
}
```

> **Note:** When `variationAttributes` is provided, backend automatically generates all variant combinations (e.g., S-Red, S-Blue, M-Red, etc.). The optional `variants` array allows setting initial priceModifiers for specific combinations.
> **Note:** `quantity` is optional and does not create stock entries. Inventory is managed via purchases/transfers/adjustments.

**Required Fields:**
- `name` (string)
- `category` (string)
- `basePrice` (number, min: 0)

**Optional Admin Fields:**
- `costPrice` (number, min: 0) - For profit calculations. Visibility is role-based (see "Role-Based Field Filtering" below).
- `vatRate` (number, 0-100) - Product-specific VAT rate override. `null` = inherit from category/platform (see "VAT Rate Configuration" above).

**Variant Fields:**
- `variationAttributes` (array) - Defines variation dimensions. Backend auto-generates variants.
- `variants` (array) - Optional initial variant overrides (priceModifier, costPrice, barcode, vatRate)

**System-Managed Fields (Auto-Generated, Cannot Update After Creation):**
- `slug` - Auto-generated from name
- `sku` - Auto-generated from name if not provided
- `variants[].sku` - Auto-generated from product SKU + attributes
- `quantity` - Synced from Inventory (sum across branches). Use purchases/transfers/adjustments to change stock.
- `stats.*` - Auto-updated by system
- `averageRating` - Auto-calculated from reviews
- `numReviews` - Auto-updated from reviews
- `productType` - Auto-detected from `variationAttributes` + `variants` (cannot be set directly)

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
PATCH /api/v1/products/:id
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

**Updating Variants (Attribute Changes):**
```json
{
  "variationAttributes": [
    { "name": "Size", "values": ["S", "M", "L"] }
  ]
}
```

> When `variationAttributes` changes, the backend automatically:
> - Generates new variants for added values
> - Marks variants as `isActive: false` for removed values (preserves history)
> - Preserves existing variant data (priceModifier, costPrice, barcode)
> - Cascades `isActive` status to StockEntry

**Updating Individual Variants:**
```json
{
  "variants": [
    { "sku": "TSHIRT-S-RED", "priceModifier": 50, "costPrice": 300, "vatRate": 10 },
    { "sku": "TSHIRT-M-RED", "isActive": false }
  ]
}
```

**⚠️ Cannot Update:** `quantity`, `stats`, `slug`, `averageRating`, `numReviews` (system-managed)
**💡 To Update Stock:** Use `POST /api/v1/pos/stock/adjust` (FE: `posApi.setStock()` / `posApi.bulkAdjust()`) - See [docs/.fe/INVENTORY_QUICK_START.md](../../docs/.fe/INVENTORY_QUICK_START.md)

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
DELETE /api/v1/products/:id
```

**Auth Required:** Yes (admin)

**Parameters:**
- `id` (path, required): Product ID

**Query Parameters:**
- `hard` (optional): Set to `true` for permanent deletion

**Default Behavior (Soft Delete):**
- Sets `deletedAt` timestamp
- Sets `isActive: false`
- Preserves product data for order history
- Deactivates related inventory (but preserves data)

**Response (Soft Delete):**
```json
{
  "success": true,
  "deleted": true,
  "productId": "507f1f77bcf86cd799439011",
  "soft": true
}
```

**Hard Delete (`?hard=true`):**
- Permanently removes product from database
- Cascades deletion to StockEntry and StockMovement
- **Use with caution** - cannot be undone

**Response (Hard Delete):**
```json
{
  "success": true,
  "deleted": true,
  "productId": "507f1f77bcf86cd799439011"
}
```

---

### Restore Deleted Product
```http
POST /api/v1/products/:id/restore
```

**Auth Required:** Yes (admin)

**Parameters:**
- `id` (path, required): Product ID

**Description:** Restores a soft-deleted product back to active state

**Response:**
```json
{
  "success": true,
  "data": { /* Restored product object */ }
}
```

---

### Get Deleted Products
```http
GET /api/v1/products/deleted
```

**Auth Required:** Yes (admin)

**Description:** Lists all soft-deleted products for admin recovery

**Query Parameters:**
- `page`, `limit`, `after` - Standard pagination params

**Response:**
```json
{
  "success": true,
  "method": "offset",
  "docs": [ /* Deleted products */ ],
  "total": 5,
  "pages": 1,
  "page": 1
}
```

---

## Custom Endpoints

### Get Product Recommendations
```http
GET /api/v1/products/:productId/recommendations
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

### Sync Product Stock (Admin)

```http
POST /api/v1/products/:id/sync-stock
```

Recomputes `product.quantity` and `stockProjection.variants` from StockEntry totals across branches.

**Auth Required:** Yes (admin, warehouse-admin, warehouse-staff, store-manager)

**Response:**
```json
{
  "success": true,
  "data": {
    "productId": "product_id",
    "totalQuantity": 120,
    "variantQuantities": [
      { "sku": "TSHIRT-M-RED", "quantity": 30 },
      { "sku": "TSHIRT-L-RED", "quantity": 12 }
    ],
    "synced": true,
    "errors": []
  }
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
| Featured grid (FE-controlled) | `GET /api/v1/products?tags=featured&limit=8&sort=-createdAt` | Treat `tags=featured` as the flag. |
| Best sellers | `GET /api/v1/products?sort=-stats.totalSales&limit=8` | Uses sales stats to surface popular items. |
| Category page | `GET /api/v1/products?category=electronics&page=1&limit=24&sort=-createdAt` | Uses offset pagination for SEO-friendly pages. |
| Category + price range | `GET /api/v1/products?category=electronics&basePrice[gte]=100&basePrice[lte]=500&sort=basePrice&page=1&limit=24` | Range filter for sliders. |
| Highly rated | `GET /api/v1/products?averageRating[gte]=4&limit=12&sort=-averageRating` | Only returns items with rating >= 4. |
| Search box | `GET /api/v1/products?search=wireless%20headphones&limit=12` | Full-text search across name/description/tags. |
| Product detail (with images) | `GET /api/v1/products/:id` | Images include `variants.thumbnail`/`variants.medium` URLs for fast rendering. |
| Recommendations widget | `GET /api/v1/products/:productId/recommendations` | Returns up to 4 related items (same category, by sales). |

### Example 1: Simple Product Listing (Offset Pagination)

**Request:**
```http
GET /api/v1/products?page=1&limit=20
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
GET /api/v1/products?limit=20&sort=-createdAt
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
GET /api/v1/products?after=eyJ2IjoxLCJ0IjoiZGF0ZSIsInYiOiIyMDI1...&limit=20&sort=-createdAt
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
GET /api/v1/products?category=electronics&page=1&limit=20
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
GET /api/v1/products?basePrice[gte]=100&basePrice[lte]=500&page=1
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
GET /api/v1/products?search=wireless headphones&limit=20
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
GET /api/v1/products?category=electronics&basePrice[lte]=300&averageRating[gte]=4&sort=-averageRating&page=1&limit=10
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
GET /api/v1/products?sort=-stats.totalSales&limit=10
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
GET /api/v1/products?sort=-createdAt&limit=10
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
GET /api/v1/products?discount.startDate[lte]=2025-12-05&discount.endDate[gte]=2025-12-05&sort=-discount.value&limit=20
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
GET /api/v1/products?numReviews[gte]=1&sort=-averageRating&limit=10
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
      ? `/api/v1/products?after=${cursor}&limit=20&sort=-createdAt`
      : `/api/v1/products?limit=20&sort=-createdAt`;

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
GET /api/v1/products?page=1000&limit=50

# ✅ Fast regardless of position
GET /api/v1/products?after=eyJ2IjoxLC...&limit=50&sort=-createdAt
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
GET /api/v1/products?select=name,basePrice,images&limit=20
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
**Cost Price Visibility (Config-Driven):**
- `costPrice`, `profitMargin`, `profitMarginPercent` are only included for roles listed in `config/sections/costPrice.config.js` under `costPrice.viewRoles`
- Public API responses automatically exclude these fields for security
- Applies to both Product and Variant cost fields
- Writes: if the caller role is not in `costPrice.manageRoles`, backend ignores `costPrice` updates in product create/update payloads

**Role Source of Truth:**
- User roles are validated by `modules/auth/user.model.js` (`roles.enum`)
- If you add a new role (e.g. `cashier`), update:
  - `modules/auth/user.model.js`
  - `config/permissions/roles.js` (and any permission groups/routes)
  - `config/sections/costPrice.config.js` (to grant view/manage access as needed)

### Slug Generation
- Product slugs are auto-generated from the product name
- Globally unique
- Lowercase, hyphenated format

---


**Last Updated:** 2025-12-21
