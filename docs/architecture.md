# Architecture Overview

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode, ESM) |
| Runtime | Node.js with tsx (dev) / tsc build |
| Framework | Fastify via **Arc 2.4.0** (`@classytic/arc`) |
| Database | MongoDB via **MongoKit 3.4.2** (`@classytic/mongokit`) + Mongoose |
| Auth | Better Auth (branch-as-organization model) |
| Events | Arc defineEvent + EventRegistry + MemoryEventTransport + EventOutbox |
| Payments | `@classytic/revenue` |
| Testing | Vitest |

---

## Directory Structure

```
src/
├── index.ts              # Entry point
├── app.ts                # Fastify app bootstrap (plugins, routes, auth)
├── types.d.ts            # Global type augmentations
│
├── config/               # Environment, permissions, feature flags
│   ├── env-loader.ts     # Env parsing/validation
│   ├── permissions/      # Role definitions, permission groups
│   ├── sections/         # Feature-specific config (costPrice, app, etc.)
│   └── validator.ts      # Runtime env validation
│
├── core/                 # Framework-level infrastructure
│   ├── events/           # Core event system setup
│   ├── factories/        # Resource/plugin factories
│   ├── middleware/        # Fastify hooks and middleware
│   ├── plugins/          # Fastify plugins (db, auth, docs)
│   ├── policies/         # Access control policies
│   └── utils/            # Framework utilities
│
├── shared/               # Cross-cutting concerns
│   ├── event-registry.ts # Central EventRegistry instance
│   ├── event-helpers.ts  # Schema conversion utilities
│   ├── permissions.ts    # Centralized permission policy map
│   ├── events/           # Shared event handlers (branch bootstrap)
│   ├── outbox/           # MongoOutboxStore (EventOutbox persistence)
│   ├── workflows/        # Step runner, workflow context
│   ├── revenue/          # Revenue library integration
│   └── ...
│
├── resources/            # Domain modules (the business logic)
│   ├── auth/             # Users, members, access control
│   ├── catalog/          # products/, categories/, reviews/
│   ├── commerce/         # branch/, coupon/, size-guide/, core/ (stock service)
│   ├── content/          # cms/, media/
│   ├── sales/            # cart/, orders/, pos/, customers/
│   ├── inventory/        # purchase/, transfer/, supplier/, stock-request/, warehouse/, flow/
│   ├── transaction/      # Financial transactions, reports
│   ├── finance/          # Finance summaries, VAT
│   ├── logistics/        # Shipping providers, tracking
│   ├── analytics/        # Dashboard analytics
│   ├── archive/          # Soft-delete archive
│   ├── export/           # Data export
│   └── platform/         # Platform settings
│
├── lib/                  # Utility libraries
│   ├── events/           # Arc event publish helpers
│   ├── utils/            # Logger, general utilities
│   ├── integrations/     # Third-party integrations
│   └── ...
│
├── routes/               # Top-level route registration
│
└── cron/                 # Background tasks
    └── index.ts          # Reservation cleanup, outbox relay
```

---

## Resource Pattern

Each resource follows a consistent layered pattern:

```
resource/
├── {name}.model.ts         # Mongoose model (MongoKit schema)
├── {name}.repository.ts    # Data access layer (MongoKit CRUD + custom queries)
├── {name}.controller.ts    # Business logic (orchestrates repository + services)
├── {name}.resource.ts      # Arc resource definition (CRUD config, permissions, hooks)
├── {name}.schemas.ts       # Zod/JSON schemas for validation
├── events.ts               # Domain events (defineEvent declarations)
├── routes.ts               # Custom route handlers beyond CRUD
└── handlers/               # (optional) Complex operation handlers
```

**Flow:** HTTP request -> Arc resource (permission check + validation) -> controller -> repository -> model -> MongoDB

---

## Event System

### Overview

The platform uses Arc 2.4.0's in-process event system for domain decoupling. No external message broker is required.

### Key Components

**defineEvent** - Declares a typed domain event with a name and optional schema:
```ts
import { defineEvent } from '@classytic/arc/events';

export const ProductCreated = defineEvent<ProductCreatedPayload>('product.created');
```

**EventRegistry** - Central catalog of all defined events. Used for introspection and optional publish-time schema validation:
```ts
import { createEventRegistry } from '@classytic/arc/events';
export const eventRegistry = createEventRegistry();
```

**MemoryEventTransport** - In-process pub/sub. Handlers subscribe to event types and execute when events are published. No network overhead, no external dependencies.

**EventOutbox (MongoDB-backed)** - For events that must survive process restarts (e.g., POS sale events). Events are written to a MongoDB collection (`OutboxEvent`) inside the same transaction as the business write. A cron relay picks up pending entries and delivers them every 5 seconds.

### Event Flow

1. Controller performs business operation
2. Controller calls `publish(EventName, payload)`
3. MemoryEventTransport delivers to subscribed handlers (in-process)
4. For critical events: also persisted to EventOutbox -> cron relay -> handlers

---

## Compensation Pattern

Order workflows use Arc's `withCompensation` for saga-style rollback:

```ts
import { withCompensation } from '@classytic/arc/utils';

const result = await withCompensation(async (compensate) => {
  // Step 1: Reserve stock
  const reservation = await stockService.reserve(items);
  compensate(() => stockService.release(reservation));

  // Step 2: Create order
  const order = await orderRepository.create(orderData);
  compensate(() => orderRepository.delete(order.id));

  // Step 3: Create transaction
  const txn = await revenue.charge(paymentData);
  // If this fails, steps 1 and 2 are automatically rolled back

  return { order, txn };
});
```

Used in: `create-order`, `fulfill-order`, `cancel-order`, `refund-order` workflows (`src/resources/sales/orders/workflows/`).

---

## Outbox Pattern for POS Transactions

POS operations require guaranteed event delivery because they involve immediate stock decrement:

1. POS checkout writes the order **and** an OutboxEvent in the same MongoDB transaction
2. MemoryEventTransport delivers the event immediately (best-effort)
3. Cron relay (every 5 seconds) picks up any `pending` OutboxEvent entries and re-delivers
4. Delivered entries are marked `delivered`; a TTL index removes them after 7 days
5. Stale claims (claimed but not acknowledged within 60 seconds) are re-eligible for relay

Implementation: `src/shared/outbox/mongo-outbox-store.ts`

---

## Background Tasks via Cron

Background processing uses `setInterval`-based cron (no job queue). Registered in `src/cron/index.ts`:

| Task | Interval | Purpose |
|------|----------|---------|
| Outbox relay | 5 seconds | Deliver pending EventOutbox entries |
| Reservation cleanup | 5 minutes | Expire stale stock reservations from abandoned checkouts |

Both tasks start automatically when the server boots.

---

## Authentication

**Better Auth** handles authentication with a branch-as-organization model:

- Users authenticate via email/password and receive Bearer tokens
- Each branch maps to a Better Auth **organization**
- Users can belong to multiple organizations (branches) with different roles
- Session management uses Bearer tokens (not cookies)

Auth configuration: `src/resources/auth/auth.config.ts`

---

## Permission System

Arc's permission system provides declarative access control at the resource level.

### Permission Helpers

| Helper | Description |
|--------|-------------|
| `allowPublic` | No authentication required |
| `requireAuth` | Must be logged in |
| `requireRoles(...roles)` | Must have one of the specified global roles |
| `requireOrgRole(...roles)` | Must have one of the specified roles in the current organization (branch) |
| `allOf(...checks)` | All checks must pass |
| `anyOf(...checks)` | At least one check must pass |
| `denyAll` | Always denied (disable an operation) |

### Usage in Resources

```ts
// src/resources/catalog/products/product.resource.ts
permissions: {
  list: allowPublic,
  get: allowPublic,
  create: requireRoles('admin', 'warehouse-admin'),
  update: requireRoles('admin', 'warehouse-admin'),
  delete: requireRoles('admin'),
}
```

Centralized policy map: `src/shared/permissions.ts`
Role definitions: `src/config/permissions/`

---

## How to Add a New Resource

### Step 1: Create the directory

```
src/resources/{domain}/{name}/
```

### Step 2: Define the model

Create `{name}.model.ts` with a MongoKit schema:
```ts
import { createModel, defineSchema } from '@classytic/mongokit';

const schema = defineSchema({ /* fields */ });
export default createModel('ModelName', schema);
```

### Step 3: Create the repository

Create `{name}.repository.ts`:
```ts
import { createRepository } from '@classytic/mongokit';
import Model from './{name}.model.js';

export default createRepository(Model);
```

### Step 4: Create the controller

Create `{name}.controller.ts` with business logic methods that call the repository.

### Step 5: Define validation schemas

Create `{name}.schemas.ts` with JSON schemas for create/update/list/params.

### Step 6: Create the resource

Create `{name}.resource.ts` using Arc's resource definition:
```ts
import { defineResource } from '@classytic/arc';

export default defineResource({
  name: 'resource-name',
  repository,
  controller,
  schemas,
  permissions: { /* per-operation permissions */ },
});
```

### Step 7: Define events

Create `events.ts` with `defineEvent` declarations and register them with the EventRegistry.

### Step 8: Register routes

Create `routes.ts` for any custom endpoints beyond CRUD, then register in `src/routes/`.

### Step 9: Add cron tasks (if needed)

If the resource needs background processing, add interval tasks in `src/cron/index.ts`.
