# Stock Movements Reference

Detailed reference for stock movement types, audit trail, and query options.

## Movement Types

Every stock change creates an immutable `StockMovement` record.

| Type | Description | Triggered By |
|------|-------------|--------------|
| `purchase` | Stock received from supplier | `POST /inventory/purchases` |
| `sale` | Stock decremented for order | POS/Web order fulfillment |
| `return` | Stock restored | Order cancellation/return |
| `adjustment` | Manual correction | `POST /inventory/adjustments` |
| `transfer_in` | Received from another branch | Transfer (challan) receive |
| `transfer_out` | Sent to another branch | Transfer (challan) dispatch |
| `initial` | Initial stock setup | Bulk import / first-time setup |
| `recount` | Physical inventory count | Adjustment with reason containing "recount" |

## Query Endpoint

```http
GET /api/v1/inventory/movements
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `productId` | string | Filter by product ID |
| `branchId` | string | Filter by branch ID |
| `type` | string | Filter by movement type (see above) |
| `startDate` | ISO string | Filter by date range start |
| `endDate` | ISO string | Filter by date range end |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 50) |

### Response

```json
{
  "success": true,
  "docs": [
    {
      "_id": "movement_id",
      "stockEntry": "stock_entry_id",
      "product": {
        "_id": "product_id",
        "name": "Cotton T-Shirt",
        "slug": "cotton-tshirt"
      },
      "variantSku": "SKU-RED-M",
      "branch": {
        "_id": "branch_id",
        "code": "DHK",
        "name": "Dhaka Store"
      },
      "type": "sale",
      "quantity": -5,
      "balanceAfter": 45,
      "costPerUnit": 250,
      "reference": {
        "model": "Order",
        "id": "order_id"
      },
      "actor": {
        "_id": "user_id",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "notes": "POS sale",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

> **Note:** `product`, `branch`, and `actor` fields may be populated with full objects or remain as ObjectId strings depending on query options.

## Reference Models

Movements are linked to source documents:

| `reference.model` | Description |
|-------------------|-------------|
| `Order` | POS or web order |
| `Transfer` | Transfer document (legacy) |
| `Challan` | Transfer/challan document (current) |
| `PurchaseOrder` | Purchase record |
| `Manual` | Manual adjustment |

## Data Retention

Movements are automatically deleted after **2 years** via MongoDB TTL index. Export historical data if long-term retention is required.

## Quantity Sign Convention

- **Positive** quantity: Stock increased (purchase, return, transfer_in)
- **Negative** quantity: Stock decreased (sale, transfer_out)
- `balanceAfter` always shows the resulting stock level

## Cost Tracking

- `costPerUnit` is recorded for `purchase` and `initial` movements
- Used for weighted average cost calculations
- May be `null` for movements that don't establish cost
