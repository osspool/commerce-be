# POS API Integration Guide

Complete reference for integrating with the Point of Sale (POS) API.

---

## Overview

The POS system enables in-store sales with features like:
- Cart-free order creation (immediate checkout)
- Barcode scanning for product lookup
- Multi-branch inventory management
- Receipt generation
- Pickup vs delivery support
- Immediate payment verification
- Cost price tracking for profit analysis

**Base URL:** `/api/v1/pos`

**Authentication:** All POS endpoints require `admin` or `store-manager` role

---

## Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/pos/lookup` | Lookup product by barcode or SKU |
| `POST` | `/api/v1/pos/orders` | Create POS order (cart-free) |
| `GET` | `/api/v1/pos/orders/:orderId/receipt` | Get order receipt data |
| `GET` | `/api/v1/pos/inventory/:productId` | Get stock levels for a product |
| `PUT` | `/api/v1/pos/inventory/:productId` | Set stock quantity |
| `GET` | `/api/v1/pos/inventory/alerts/low-stock` | Get low stock items |
| `GET` | `/api/v1/pos/inventory/movements` | Get stock movement history |
| `POST` | `/api/v1/pos/inventory/adjust` | Bulk stock adjustment |
| `PATCH` | `/api/v1/pos/inventory/barcode` | Update product/variant barcode |
| `GET` | `/api/v1/pos/inventory/labels` | Get label data for barcode printing |
| `GET` | `/api/v1/pos/branches` | List all active branches |
| `GET` | `/api/v1/pos/branches/default` | Get default branch |

---

## Order Management

### Product Lookup (Barcode Scanning)

```http
GET /api/v1/pos/lookup?code=BARCODE123
Authorization: Bearer <admin_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Barcode or SKU to search |

**Response:**
```json
{
  "success": true,
  "data": {
    "product": {
      "_id": "product_id",
      "name": "T-Shirt",
      "basePrice": 500,
      "costPrice": 300,
      "sku": "TSHIRT-001",
      "barcode": "BARCODE123",
      "variations": [
        {
          "name": "Size",
          "options": [
            {
              "value": "M",
              "sku": "TSHIRT-RED-M",
              "barcode": "BARCODE456",
              "priceModifier": 0,
              "costPrice": 280,
              "quantity": 50
            }
          ]
        }
      ]
    },
    "stockEntry": {
      "_id": "stock_entry_id",
      "quantity": 50,
      "reservedQuantity": 0,
      "availableQuantity": 50,
      "costPrice": 280,
      "branch": "branch_id"
    }
  }
}
```

---

### Create POS Order

Creates an order immediately at the POS terminal. Supports both pickup (customer takes items) and delivery (home delivery).

```http
POST /api/v1/pos/orders
Authorization: Bearer <admin_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "items": [
    {
      "productId": "product_id",
      "variantSku": "TSHIRT-RED-M",
      "quantity": 2,
      "price": 500
    }
  ],
  "customer": {
    "id": "customer_id",
    "name": "John Doe",
    "phone": "01712345678"
  },
  "payment": {
    "method": "cash",
    "amount": 1000,
    "reference": "CASH-001"
  },
  "discount": 50,
  "branchId": "branch_id",
  "branchSlug": "dhaka-main",
  "terminalId": "POS-1",
  "deliveryMethod": "pickup",
  "notes": "Customer paid cash"
}
```

**Request Body Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | Yes | Array of order items |
| `items[].productId` | string | Yes | Product ID |
| `items[].variantSku` | string | No | Variant SKU (if product has variants) |
| `items[].quantity` | number | Yes | Quantity (minimum: 1) |
| `items[].price` | number | Yes | Unit price |
| `customer` | object | No | Customer information (optional for walk-in) |
| `customer.id` | string | No | Existing customer ID |
| `customer.name` | string | No | Customer name |
| `customer.phone` | string | No | Customer phone |
| `payment` | object | No | Payment information |
| `payment.method` | string | No | Payment method: `cash`, `bkash`, `nagad`, `card` (default: `cash`) |
| `payment.amount` | number | No | Payment amount (defaults to total) |
| `payment.reference` | string | No | Payment reference/TrxID |
| `discount` | number | No | Discount amount (default: 0) |
| `branchId` | string | No | Branch ID (uses default if not provided) |
| `branchSlug` | string | No | Branch slug (alternative to branchId) |
| `terminalId` | string | No | POS terminal identifier |
| `deliveryMethod` | string | No | `pickup` or `delivery` (default: `pickup`) |
| `deliveryAddress` | object | No | Required if deliveryMethod is `delivery` |
| `deliveryAddress.recipientPhone` | string | Yes* | Contact phone (*required for delivery) |
| `deliveryAddress.addressLine1` | string | Yes* | Street address (*required for delivery) |
| `deliveryAddress.areaId` | number | No | Area ID from bd-areas |
| `deliveryAddress.areaName` | string | No | Area name |
| `deliveryAddress.zoneId` | number | No | Zone ID for pricing (1-6) |
| `deliveryAddress.city` | string | No | City |
| `deliveryPrice` | number | No | Delivery charge (default: 0) |
| `notes` | string | No | Order notes |

**Delivery Methods:**
- **`pickup`** (default): Customer takes items immediately
  - Inventory decremented immediately
  - Order status: `delivered`
  - Payment status: `verified`
- **`delivery`**: Home delivery
  - Inventory decremented at fulfillment
  - Order status: `processing`
  - Payment status: `verified`

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "order_id",
    "source": "pos",
    "status": "delivered",
    "branch": "branch_id",
    "cashier": "user_id",
    "terminalId": "POS-1",
    "customer": "customer_id",
    "customerName": "John Doe",
    "customerPhone": "01712345678",
    "items": [
      {
        "_id": "item_id",
        "product": "product_id",
        "productName": "T-Shirt",
        "productSlug": "t-shirt",
        "variantSku": "TSHIRT-RED-M",
        "variations": [
          {
            "name": "Size",
            "option": {
              "value": "M",
              "priceModifier": 0
            }
          }
        ],
        "quantity": 2,
        "price": 500,
        "costPriceAtSale": 280
      }
    ],
    "subtotal": 1000,
    "discountAmount": 50,
    "totalAmount": 950,
    "delivery": {
      "method": "pickup",
      "price": 0
    },
    "deliveryAddress": {
      "addressLine1": "Branch Name",
      "city": "Dhaka"
    },
    "currentPayment": {
      "amount": 950,
      "method": "cash",
      "status": "verified",
      "reference": "CASH-001",
      "verifiedAt": "2025-12-11T10:00:00.000Z",
      "verifiedBy": "user_id"
    },
    "createdAt": "2025-12-11T10:00:00.000Z",
    "updatedAt": "2025-12-11T10:00:00.000Z"
  },
  "message": "Order created successfully"
}
```

**Error Responses:**
```json
{
  "success": false,
  "message": "At least one item is required"
}
```

```json
{
  "success": false,
  "message": "Product not found: product_id"
}
```

```json
{
  "success": false,
  "message": "Insufficient stock"
}
```

---

### Get Order Receipt

Retrieve formatted receipt data for an order.

```http
GET /api/v1/pos/orders/:orderId/receipt
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "orderId": "order_id",
    "orderNumber": "12345678",
    "date": "2025-12-11T10:00:00.000Z",
    "status": "delivered",
    "branch": {
      "name": "Dhaka Main Branch",
      "address": {
        "addressLine1": "123 Main St",
        "city": "Dhaka"
      },
      "phone": "01712345678"
    },
    "cashier": "Staff Name",
    "customer": {
      "name": "John Doe",
      "phone": "01712345678"
    },
    "items": [
      {
        "name": "T-Shirt",
        "variant": "M",
        "quantity": 2,
        "unitPrice": 500,
        "total": 1000
      }
    ],
    "subtotal": 1000,
    "discount": 50,
    "deliveryCharge": 0,
    "total": 950,
    "delivery": {
      "method": "pickup",
      "address": null
    },
    "payment": {
      "method": "cash",
      "amount": 950,
      "reference": "CASH-001"
    }
  }
}
```

---

## Inventory Management

### Get Product Stock

```http
GET /api/v1/pos/inventory/:productId?branchId=branch_id
Authorization: Bearer <admin_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branchId` | string | No | Filter by branch (shows all branches if not provided) |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "product": "product_id",
      "variantSku": "TSHIRT-RED-M",
      "branch": "branch_id",
      "quantity": 50,
      "reservedQuantity": 5,
      "availableQuantity": 45,
      "costPrice": 280,
      "reorderPoint": 10,
      "reorderQuantity": 50,
      "needsReorder": false
    }
  ]
}
```

---

### Set Stock Quantity

```http
PUT /api/v1/pos/inventory/:productId
Authorization: Bearer <admin_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "variantSku": "TSHIRT-RED-M",
  "branchId": "branch_id",
  "quantity": 100,
  "notes": "Physical count correction"
}
```

---

### Bulk Stock Adjustment

Process multiple stock adjustments atomically. Supports set (absolute), add (receive), remove (damage/shrinkage) modes.

```http
POST /api/v1/pos/inventory/adjust
Authorization: Bearer <admin_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "adjustments": [
    {
      "productId": "product_id",
      "variantSku": "TSHIRT-RED-M",
      "quantity": 100,
      "mode": "set",
      "reason": "Initial stock",
      "barcode": "BARCODE456"
    },
    {
      "productId": "product_id_2",
      "quantity": 50,
      "mode": "add",
      "reason": "Stock received"
    }
  ],
  "branchId": "branch_id",
  "reason": "Monthly stock update"
}
```

**Adjustment Modes:**
- `set`: Set absolute quantity (overwrites existing)
- `add`: Add to existing quantity (stock received)
- `remove`: Remove from existing quantity (damage, theft, etc.)

---

### Update Barcode

```http
PATCH /api/v1/pos/inventory/barcode
Authorization: Bearer <admin_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "productId": "product_id",
  "variantSku": "TSHIRT-RED-M",
  "barcode": "NEW_BARCODE_123"
}
```

**Note:** Validates barcode uniqueness across all products.

---

### Get Low Stock Items

```http
GET /api/v1/pos/inventory/alerts/low-stock?branchId=branch_id&threshold=10
Authorization: Bearer <admin_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branchId` | string | No | Filter by branch |
| `threshold` | number | No | Custom threshold (overrides reorderPoint) |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "product": {
        "_id": "product_id",
        "name": "T-Shirt"
      },
      "variantSku": "TSHIRT-RED-M",
      "branch": "branch_id",
      "quantity": 5,
      "reorderPoint": 10,
      "reorderQuantity": 50,
      "needsReorder": true
    }
  ]
}
```

---

### Get Stock Movement History

```http
GET /api/v1/pos/inventory/movements?productId=product_id&branchId=branch_id&type=sale&startDate=2025-01-01&endDate=2025-12-31&page=1&limit=20
Authorization: Bearer <admin_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `productId` | string | No | Filter by product |
| `branchId` | string | No | Filter by branch |
| `type` | string | No | Movement type: `sale`, `return`, `adjustment`, `transfer_in`, `transfer_out`, `initial`, `recount`, `purchase` |
| `startDate` | string | No | Filter movements after this date (ISO format) |
| `endDate` | string | No | Filter movements before this date (ISO format) |
| `page` | number | No | Page number (default: 1) |
| `limit` | number | No | Items per page (default: 20) |

**Response:**
```json
{
  "success": true,
  "docs": [
    {
      "_id": "movement_id",
      "stockEntry": "stock_entry_id",
      "product": "product_id",
      "variantSku": "TSHIRT-RED-M",
      "branch": "branch_id",
      "type": "sale",
      "quantity": -2,
      "balanceAfter": 48,
      "costPerUnit": 280,
      "reference": {
        "model": "Order",
        "id": "order_id"
      },
      "actor": "user_id",
      "createdAt": "2025-12-11T10:00:00.000Z"
    }
  ],
  "total": 100,
  "page": 1,
  "pages": 5
}
```

---

### Get Label Data for Barcode Printing

Returns formatted data for frontend to render barcode labels using libraries like JsBarcode.

```http
GET /api/v1/pos/inventory/labels?productIds=product_id1,product_id2&branchId=branch_id
Authorization: Bearer <admin_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `productIds` | string | No | Comma-separated product IDs |
| `variantSkus` | string | No | Comma-separated variant SKUs |
| `branchId` | string | No | Filter by branch |

---

## Branch Management

### List All Active Branches

```http
GET /api/v1/pos/branches
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "branch_id",
      "code": "DHK-MAIN",
      "name": "Dhaka Main Branch",
      "slug": "dhaka-main",
      "type": "store",
      "address": {
        "addressLine1": "123 Main St",
        "city": "Dhaka"
      },
      "phone": "01712345678",
      "isActive": true
    }
  ]
}
```

---

### Get Default Branch

Auto-creates a default branch if none exists.

```http
GET /api/v1/pos/branches/default
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "branch_id",
    "code": "DEFAULT",
    "name": "Main Branch",
    "slug": "main-branch",
    "type": "store",
    "isDefault": true,
    "isActive": true
  }
}
```

---

## Frontend Integration Examples

### POS Checkout Flow

```javascript
// 1. Scan product barcode
const lookupResult = await fetch('/api/v1/pos/lookup?code=BARCODE123', {
  headers: { Authorization: `Bearer ${token}` }
});
const { data } = await lookupResult.json();

// 2. Add to cart (frontend state)
const cart = [
  {
    productId: data.product._id,
    variantSku: data.product.variations[0].options[0].sku,
    quantity: 1,
    price: data.product.basePrice
  }
];

// 3. Apply discount (frontend)
const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
const discount = 50;
const total = subtotal - discount;

// 4. Collect payment and create order
const orderPayload = {
  items: cart,
  customer: {
    name: 'John Doe',
    phone: '01712345678'
  },
  payment: {
    method: 'cash',
    amount: total
  },
  discount,
  terminalId: 'POS-1',
  deliveryMethod: 'pickup'
};

const orderResult = await fetch('/api/v1/pos/orders', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(orderPayload)
});

const { data: order } = await orderResult.json();

// 5. Print receipt
const receiptResult = await fetch(`/api/v1/pos/orders/${order._id}/receipt`, {
  headers: { Authorization: `Bearer ${token}` }
});
const { data: receipt } = await receiptResult.json();

console.log('Order created:', order._id);
console.log('Print receipt:', receipt);
```

---

## Key Differences: POS vs Web Orders

| Feature | POS Orders | Web Orders |
|---------|-----------|------------|
| **Cart** | Cart-free (direct checkout) | Cart-based checkout |
| **Inventory** | Immediate decrement (pickup) | Decrement at fulfillment |
| **Payment** | Immediately verified | Pending → Manual verification |
| **Status** | `delivered` (pickup) or `processing` (delivery) | `pending` → `processing` → `confirmed` |
| **Branch** | Required | Optional |
| **Customer** | Optional (walk-in) | Required |
| **Source** | `pos` | `web` |
| **Cost Tracking** | Captured at sale time | Captured at sale time |

---

## Cost Price & Profit Tracking

All orders (both POS and web) automatically capture cost prices at sale time for profit analysis:

**Order Item Structure:**
```json
{
  "product": "product_id",
  "productName": "T-Shirt",
  "price": 500,
  "costPriceAtSale": 280,
  "quantity": 2
}
```

**Profit Calculation (Virtuals):**
```javascript
item.profit = (price - costPriceAtSale) * quantity  // 440
item.profitMargin = ((price - costPriceAtSale) / price) * 100  // 44%
```

**Cost Price Hierarchy:**
1. `StockEntry.costPrice` (branch-specific, most accurate)
2. `Variant.costPrice` (if variant exists)
3. `Product.costPrice` (default)
4. `0` (if not set)

**Role-Based Access:**
- **Admin, Store-Manager**: Can view cost prices and profit margins
- **Other roles**: Cost prices hidden from API responses

---

## Error Handling

**Common Error Responses:**

| Status | Message | Description |
|--------|---------|-------------|
| 400 | At least one item is required | Empty items array |
| 400 | Product not found: product_id | Invalid product ID |
| 400 | Invalid branch | Branch not found |
| 400 | Insufficient stock | Stock quantity too low |
| 401 | Unauthorized | Missing or invalid token |
| 403 | Access denied | Insufficient role permissions |
| 404 | Order not found | Invalid order ID |

---

## Best Practices

1. **Barcode Scanning**
   - Use `/lookup` endpoint for fast product lookup
   - Cache product data for offline mode
   - Validate stock before adding to cart

2. **Stock Management**
   - Use bulk adjust for initial stock setup
   - Set reorder points for automatic alerts
   - Regular physical counts with adjustment notes

3. **Payment Handling**
   - Verify payment before creating order
   - Store payment reference for reconciliation
   - Print receipt immediately after order creation

4. **Branch Management**
   - Always specify branch for accurate inventory
   - Use branch slug for human-readable URLs
   - Sync terminal with default branch on startup

5. **Error Recovery**
   - Handle stock errors gracefully (show alternative products)
   - Retry failed requests with exponential backoff
   - Log all transactions for audit trail

---

## Related Guides

- [Order API Guide](../order/ORDER_API_GUIDE.md) - Web order management
- [Product API Guide](../product/PRODUCT_API_GUIDE.md) - Product catalog management
- [Checkout API Guide](../order/CHECKOUT_API_GUIDE.md) - Web checkout flow
