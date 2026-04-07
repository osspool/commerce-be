# API Documentation

Complete API reference for the BigBoss e-commerce platform.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js with tsx (dev) / tsc build
- **Framework:** Fastify via **Arc 2.4.0** (`@classytic/arc`)
- **Database:** MongoDB via **MongoKit 3.4.2** (`@classytic/mongokit`) + Mongoose
- **Auth:** Better Auth (branch-as-organization model)
- **Events:** Arc defineEvent + EventRegistry + MemoryEventTransport + EventOutbox
- **Payments:** `@classytic/revenue`
- **Testing:** Vitest

## Source Directory Structure

```
src/
├── config/         # Environment, permissions, feature flags
├── core/           # Framework plugins, middleware, policies
├── shared/         # Cross-cutting: event registry, outbox, permissions, workflows
├── resources/      # Domain modules (see below)
├── lib/            # Utility libraries (logger, integrations, adapters)
├── routes/         # Top-level route registration
└── cron/           # Background tasks (reservation cleanup, outbox relay)
```

## API Docs Structure

```
docs/api/
├── auth/           # Authentication & authorization
├── catalog/        # Products, categories
├── commerce/       # Branch, coupon, size guides
├── finance/        # Financial reporting, transactions
├── inventory/      # Stock, purchases, transfers
├── logistics/      # Shipping & logistics utilities
├── media/          # File uploads
├── platform/       # Platform configuration
└── sales/          # Cart, checkout, orders, POS, customers
```

---

## Catalog APIs

Product catalog and categorization.

| API | Description |
|-----|-------------|
| [Product](catalog/product.md) | Product catalog, variants, pricing |
| [Category](catalog/category.md) | Category hierarchy and sync |
| [Review](catalog/review.md) | Product reviews and ratings |

---

## Sales APIs

Customer-facing sales flows.

| API | Description |
|-----|-------------|
| [Cart](sales/cart.md) | Shopping cart management |
| [Checkout](sales/checkout.md) | Web checkout flow |
| [Order](sales/order.md) | Order lifecycle and fulfillment |
| [POS](sales/pos.md) | Point of sale operations |
| [Customer](sales/customer.md) | Customer profiles, addresses |
| [Loyalty](../loyalty.md) | Membership, points, tiers, redemption |

---

## Inventory APIs

Stock and supply chain management.

| API | Description |
|-----|-------------|
| [Inventory](inventory/inventory.md) | Stock management overview |
| [Warehouse](inventory/warehouse.md) | Nodes, locations, audits, availability, reservations |
| [Purchases](inventory/purchases.md) | Supplier purchases, payments |
| [Challan (Transfers)](inventory/challan.md) | Inter-branch transfers |
| [Stock Movements](inventory/stock-movements.md) | Movement types, audit trail |
| [Vendor](inventory/vendor.md) | Supplier management |

---

## Finance APIs

Financial reporting and transactions.

| API | Description |
|-----|-------------|
| [Transaction](finance/transaction.md) | Financial transactions, payments |
| [Finance](finance/finance.md) | Finance dashboard, summaries, VAT reporting |

---

## Commerce APIs

Multi-branch and promotions.

| API | Description |
|-----|-------------|
| [Branch](commerce/branch.md) | Multi-branch configuration |
| [Coupon](commerce/coupon.md) | Discount codes and promotions |
| [Size Guide](commerce/size-guide.md) | Product sizing reference |

---

## Logistics APIs

Shipping utilities and provider integrations.

| API | Description |
|-----|-------------|
| [Logistics](logistics/logistics.md) | Charges, pickup stores, tracking, cancellations |

---

## Platform APIs

System configuration and utilities.

| API | Description |
|-----|-------------|
| [Platform](platform/platform.md) | Platform configuration, settings |
| [Media](media/media.md) | File uploads, image management |

---

## Authentication

| API | Description |
|-----|-------------|
| [Auth](auth/auth.md) | Sign-in/up, password reset, bearer sessions, branch (org) management |

---

## Event-Driven Architecture

The platform uses Arc 2.4.0's event system for domain decoupling:

- **defineEvent** declares typed domain events per resource (e.g., `product.created`, `order.fulfilled`).
- **EventRegistry** catalogs all events for introspection and optional schema validation.
- **MemoryEventTransport** delivers events in-process (no external broker required).
- **EventOutbox** (MongoDB-backed) ensures at-least-once delivery for critical flows like POS transactions. A cron relay delivers pending outbox events every 5 seconds.
- **withCompensation** provides saga-style rollback for multi-step order workflows (create, fulfill, cancel, refund).

Background tasks run via cron intervals (no job queue):
- Reservation cleanup (every 5 minutes)
- Outbox relay (every 5 seconds)

---

## Quick Reference

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

---

## Architecture Docs

For system design and setup guides, see:
- [Architecture Overview](../architecture.md)
- [Production Setup (Bangladesh)](../PRODUCTION_SETUP_BD.md)
