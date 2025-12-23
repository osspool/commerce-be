# Vendor (Supplier) API

Vendors are stored as **Suppliers** in the inventory system.  
Use this API to create and manage suppliers for purchase invoices.

Base path: `/api/v1/inventory/suppliers`

## Response Conventions

**Single resource:**
```json
{
  "success": true,
  "data": { "..." : "..." }
}
```

**List (MongoKit pagination):**
```json
{
  "success": true,
  "method": "offset",
  "docs": [],
  "total": 120,
  "pages": 6,
  "page": 1,
  "limit": 20,
  "hasNext": true,
  "hasPrev": false
}
```

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/inventory/suppliers` | Create vendor (supplier) |
| GET | `/api/v1/inventory/suppliers` | List vendors |
| GET | `/api/v1/inventory/suppliers/:id` | Get vendor by ID |
| PATCH | `/api/v1/inventory/suppliers/:id` | Update vendor |
| DELETE | `/api/v1/inventory/suppliers/:id` | Deactivate vendor |

## Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Vendor name |
| `code` | string | Optional code (auto-generated if omitted) |
| `type` | string | `local`, `import`, `manufacturer`, `wholesaler` |
| `contactPerson` | string | Primary contact |
| `phone` | string | Phone number |
| `email` | string | Email address |
| `address` | string | Address |
| `taxId` | string | Tax ID or BIN |
| `paymentTerms` | string | `cash` or `credit` |
| `creditDays` | number | Credit days (0 for cash) |
| `creditLimit` | number | Credit limit in BDT |
| `openingBalance` | number | Opening payable balance |
| `notes` | string | Internal notes |
| `tags` | array | Free-form tags |
| `isActive` | boolean | Active/inactive vendor |

**Uniqueness:** Vendor names are treated as case-insensitive for active suppliers.

**Note:** Supplier payment terms/credit days are defaults and can be overridden per purchase invoice.

## List Vendors

```http
GET /api/v1/inventory/suppliers
```

**Query params (MongoKit):**
| Param | Description |
|-------|-------------|
| `page` | Page number (offset pagination) |
| `after`/`cursor` | Cursor token (keyset pagination) |
| `limit` | Items per page (default 20) |
| `sort` | Sort fields (e.g. `-createdAt`) |
| `search` | Text search (name, code) |
| `type` | Filter by type |
| `paymentTerms` | Filter by payment terms |
| `isActive` | Filter active/inactive |

**Response:** MongoKit list response (see above).

## Create Vendor

```http
POST /api/v1/inventory/suppliers
```

```json
{
  "name": "ABC Supplier",
  "type": "local",
  "paymentTerms": "credit",
  "creditDays": 15,
  "phone": "01712345678",
  "address": "Dhaka",
  "notes": "Preferred for electronics"
}
```

Response (201):
```json
{
  "success": true,
  "data": {
    "_id": "supplier_id",
    "name": "ABC Supplier",
    "code": "SUP-0001",
    "type": "local",
    "paymentTerms": "credit",
    "creditDays": 15,
    "isActive": true,
    "createdAt": "2025-12-20T10:00:00.000Z"
  }
}
```

## Update Vendor

```http
PATCH /api/v1/inventory/suppliers/:id
```

```json
{
  "paymentTerms": "cash",
  "creditDays": 0,
  "notes": "Switched to cash terms"
}
```

## Deactivate Vendor

```http
DELETE /api/v1/inventory/suppliers/:id
```

This marks `isActive=false` and keeps audit history intact.
