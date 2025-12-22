# API Documentation

Complete API reference for the BigBoss e-commerce platform.

## Commerce APIs

Core e-commerce functionality.

| API | Description |
|-----|-------------|
| [Product](commerce/product.md) | Product catalog, variants, pricing |
| [Category](commerce/category.md) | Category hierarchy and sync |
| [Inventory](commerce/inventory.md) | Stock management, purchases, transfers |
| [POS](commerce/pos.md) | Point of sale operations |
| [Cart](commerce/cart.md) | Shopping cart management |
| [Checkout](commerce/checkout.md) | Web checkout flow |
| [Order](commerce/order.md) | Order lifecycle and fulfillment |
| [Branch](commerce/branch.md) | Multi-branch configuration |
| [Coupon](commerce/coupon.md) | Discount codes and promotions |

### Inventory Reference

Detailed inventory subsystem documentation:

| Reference | Description |
|-----------|-------------|
| [Stock Movements](commerce/inventory/stock-movements.md) | Movement types, audit trail, queries |
| [Challan (Transfers)](commerce/inventory/challan.md) | Transfer workflow, status history |

## Authentication & Users

| API | Description |
|-----|-------------|
| [Auth](auth.md) | Registration, login, password reset, JWT tokens |
| [Customer](customer.md) | Customer profiles, addresses, POS lookup |

## Platform APIs

| API | Description |
|-----|-------------|
| [Platform](platform.md) | Platform configuration, settings |
| [Transaction](transaction.md) | Financial transactions, payments |
| [Finance](finance.md) | Financial reporting, summaries |
| [Media](media.md) | File uploads, image management |

## Quick Links

### Authentication
All endpoints require Bearer token authentication (except public auth routes):
```
Authorization: Bearer <token>
```

### Base URLs
- Commerce: `/api/v1/` (products, orders, inventory, etc.)
- Platform: `/api/v1/platform/`
- POS: `/api/v1/pos/`

### Common Patterns

**Stripe-style Actions:** State transitions use action endpoints:
```http
POST /api/v1/inventory/transfers/:id/action
{ "action": "approve" }
```

**Pagination:** Cursor-based for lists:
```http
GET /api/v1/products?limit=50&after=<cursor>
```

**Idempotency:** Duplicate prevention:
```http
POST /api/v1/pos/orders
{ "idempotencyKey": "unique-key-here" }
```

## Architecture Docs

For system design and setup guides, see:
- [Commerce Architecture](../COMMERCE_ARCHITECTURE_REVIEW.md)
- [Production Setup (Bangladesh)](../PRODUCTION_SETUP_BD.md)
