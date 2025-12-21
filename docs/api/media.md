# Media API Guide

**Base URL:** `/api/v1/media` | **Auth:** `admin` role required

---

## Upload

### `POST /upload`
```
Content-Type: multipart/form-data
```

| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | Image file |
| `folder` | No | Base folder: `products`, `categories`, `banners`, `blog`, `users`, `brands` (default: `general`) |
| `alt` | No | Alt text (auto-generated from filename if empty) |
| `title` | No | Image title |

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "64f1a2b3c4d5e6f7a8b9c0d1",
    "url": "https://cdn.example.com/products/product-abc123.webp",
    "filename": "product-abc123.webp",
    "folder": "products",
    "alt": "my product",
    "size": 125430,
    "dimensions": { "width": 2048, "height": 2730 },
    "variants": [
      { "name": "thumbnail", "url": "...", "width": 150, "height": 200 },
      { "name": "medium", "url": "...", "width": 600, "height": 800 },
      { "name": "large", "url": "...", "width": 1200, "height": 1600 }
    ],
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### `POST /upload-multiple`
Same as above, but `files[]` array (max 20). Returns `{ success, data: [<media>, ...] }`

---

## List

### `GET /`

| Param | Description |
|-------|-------------|
| `folder` | Filter by folder: `products`, `categories`, etc. |
| `page` | Page number |
| `limit` | Results per page (max 100) |
| `search` | Search filename, alt, title |
| `sort` | Sort field (e.g., `-createdAt`) |

**Response:**
```json
{
  "success": true,
  "docs": [
    { "_id": "...", "url": "...", "folder": "products", "variants": [...] }
  ],
  "total": 45,
  "page": 1,
  "pages": 3,
  "limit": 20
}
```

---

## Single Item

### `GET /:id`
**Response:** `{ success, data: <media> }`

### `PATCH /:id`
```json
{ "alt": "new alt", "title": "new title" }
```
**Response:** `{ success, data: <media> }`

### `DELETE /:id`
**Response:** `{ success: true, message: "Media deleted" }`

---

## Bulk Operations

### `POST /bulk-delete`
```json
{ "ids": ["64f...", "64e..."] }
```
**Response:** `{ success, data: { success: [...], failed: [] }, message: "Deleted 2 of 2 files" }`

### `POST /move`
```json
{ "ids": ["64f...", "64e..."], "targetFolder": "banners" }
```
**Response:** `{ success, data: { modifiedCount: 2 } }`

---

## Folders

### `GET /folders`
Returns allowed folders for dropdown.

**Response:**
```json
{
  "success": true,
  "data": ["general", "products", "categories", "blog", "users", "banners", "brands"]
}
```

---

## Config

| Setting | Value |
|---------|-------|
| **Folders** | `general`, `products`, `categories`, `blog`, `users`, `banners`, `brands` |
| **Variants** | `thumbnail` (150×200), `medium` (600×800), `large` (1200×1600) |
| **Max Size** | 50MB |
| **Format** | Auto-converted to WebP |

---

## FE Example

```tsx
// Upload
const form = new FormData();
form.append('file', file);
form.append('folder', 'products');
const { data } = await api.post('/api/media/upload', form);

// List by folder
const { docs } = await api.get('/api/media?folder=products&limit=20');

// Get variant
const thumbnail = media.variants?.find(v => v.name === 'thumbnail')?.url || media.url;
```
