@../AGENTS.md

# be-prod — Backend API

## 📂 wiki/ — read this first for any flow you're touching

`be-prod/wiki/` is a token-light map of how subsystems wire up. Each page is a
short ASCII flow with `file:line` anchors — you can plan a refactor without
reading the codebase. **Update the relevant page when the linked code changes.**

- [wiki/order/](wiki/order/) — order lifecycle, RMA, refund, fulfillment money flow
- (more subsystems — append to [wiki/README.md](wiki/README.md) when you start one)

If you change [`services/refund.service.ts`](src/resources/sales/orders/services/refund.service.ts) or any [`lifecycle/handlers/`](src/resources/sales/orders/lifecycle/handlers/) file, also update [wiki/order/cancel.md](wiki/order/cancel.md), [refund-admin.md](wiki/order/refund-admin.md), or [rma-admin.md](wiki/order/rma-admin.md). If a flow you encounter has no wiki page yet, **add one** in the same shape (under 60 lines, ASCII flow, files table).

## Stack

- **Fastify** via Arc 2.13 (`@classytic/arc`) — resource-oriented REST. **Flat wire shape** (no `{success,data}` envelope); errors thrown as `ArcError` and emitted as canonical `ErrorContract`
- **MongoDB** via MongoKit 3.4 (`@classytic/mongokit`) — repository pattern + Mongoose
- **Better Auth 1.6.2** — bearer tokens, org-as-branch, `x-organization-id` scoping
- **@classytic/flow** — WMS kernel, mode-gated (`FLOW_MODE=simple|standard|enterprise`)
- **Vitest** — tests with MongoMemoryServer, Arc's `setupBetterAuthOrg` helper

## Source Layout

```
src/
├── config/          # Env, permissions (roles.ts, inventory.ts), feature flags
├── core/            # Arc plugins, middleware, policies
├── resources/       # Domain modules
│   ├── auth/        # Better Auth config + routes
│   ├── catalog/     # Products, categories, reviews
│   ├── commerce/    # Branch, coupons, size guides
│   ├── inventory/   # Stock, transfers, purchases, warehouse (Flow-backed)
│   │   ├── flow/    # Flow engine singleton, context helpers, bootstrap
│   │   ├── warehouse/ # Node, location, audit + advanced (lot, package, procurement...)
│   │   ├── transfer/  # Inter-branch transfers (dual Flow contexts)
│   │   ├── purchase/  # Supplier purchase invoices
│   │   └── ...
│   ├── sales/       # Cart, checkout, orders, POS, loyalty
│   └── platform/    # Platform config singleton
├── routes/          # Top-level route registration
└── cron/            # Reservation cleanup, outbox relay
```

## How Inventory Works

1. **Branch scoping**: `x-organization-id` → `getFlowContext(req)` → `{ organizationId: branchId }`
2. **Bootstrap**: First request per branch auto-creates warehouse node + 4 locations
3. **Stock mutations**: All go through Flow — `flow.services.move`, `flow.services.posting`
4. **Transfers**: Dual contexts — `buildFlowContext(sender)` decrements, `buildFlowContext(receiver)` increments
5. **Mode gating**: Advanced features check `flow().services.mode` → return 403 if insufficient

## Resource Pattern

### Standard resource (has its own Mongoose model + MongoKit repository)

Arc auto-generates CRUD (list/get/create/update/delete) from the adapter.
Only override controller methods when business logic requires it (e.g. custom create with document numbering).
Use `routes` for truly custom endpoints (stats, export, etc.).
Use `actions` for state transitions (Stripe-style `POST /:id/action`).

```typescript
import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import { createAdapter } from '#shared/adapter.js';
import permissions from '#config/permissions.js';

export default defineResource({
  name: 'my-resource',
  prefix: '/my-resources',
  audit: true,
  adapter: createAdapter(MyModel, myRepository),
  queryParser: new QueryParser({ maxLimit: 100, allowedFilterFields: ['status'] }),
  permissions: {
    list: permissions.myModule.view,
    get: permissions.myModule.view,
    create: permissions.myModule.manage,
    update: permissions.myModule.manage,
    delete: requireRoles('admin'),
  },
  // Declarative state transitions → POST /:id/action
  actions: {
    approve: {
      handler: async (id, data, req) => { ... },
      permissions: permissions.myModule.manage,
    },
  },
  // Only truly custom routes — NOT reimplemented CRUD
  routes: [
    { method: 'GET', path: '/stats', permissions: permissions.myModule.view,
      raw: true, handler: async (req, reply) => { ... } },
  ],
});
```

**What you get for free**: pagination, filtering, sorting, field validation, body sanitization,
audit trail, hooks (before/after lifecycle), org-scoping, OpenAPI docs, MCP tools.

### Flow-wrapper resource (delegates to @classytic/flow engine)

Use `disableDefaultRoutes: true` ONLY when the resource has no own model (wraps Flow/ledger/promo).

```typescript
export default defineResource({
  name: 'warehouse-node',
  prefix: '/inventory/warehouses',
  disableDefaultRoutes: true,
  routes: [
    { method: 'GET', path: '/', permissions: requireAuth(), raw: true,
      handler: async (req, reply) => {
        const data = await flow().repositories.node.list(getFlowContext(req));
        reply.send(data); // Arc 2.13+: emit raw payload — no envelope
      },
    },
  ],
});
```

### Wire shape — Arc 2.13+ (flat, no envelope)

Success responses emit the payload directly. Errors throw and the global handler emits the canonical `ErrorContract`.

```typescript
// ✅ Success — return / send the payload directly
return reply.send(page);                       // raw: true handlers
return { data: page };                         // controller methods (IControllerResponse<T>)
return { data: page, status: 201 };            // with explicit status

// ✅ Errors — throw, never return
import {
  NotFoundError, ValidationError, ForbiddenError,
  UnauthorizedError, ConflictError, RateLimitError,
  ServiceUnavailableError, createError, createDomainError,
} from '@classytic/arc/utils';

if (!page) throw new NotFoundError('Page');                    // 404
if (invalid) throw new ValidationError('email is required');   // 400
if (locked) throw createDomainError('PERIOD_LOCKED', 'Period is closed', 409);
throw createError(503, 'Quality service unavailable');         // anything else

// ❌ Don't construct envelopes by hand
return reply.code(200).send({ success: true, data: page });       // wrong
return reply.code(404).send({ success: false, error: 'X' });      // wrong
return { success: false, error: 'msg', status: 400 };             // wrong
```

The error handler emits `{ code, message, status, details?, meta?, correlationId? }` for any thrown `ArcError`. `code` is `arc.<canonical>` (e.g. `arc.not_found`) for the bundled subclasses; pass a custom code via `createDomainError(code, msg, status)` when downstream clients need to discriminate beyond HTTP status.

### Do NOT
- Use `disableDefaultRoutes: true` when you have a model + repository — use the adapter instead
- Use `raw: true` for CRUD routes — this bypasses Arc's entire pipeline (audit, hooks, permissions, pagination)
- Reimplement GET /, GET /:id, POST /, PATCH /:id as raw Fastify handlers — Arc generates these
- Write barrel `index.ts` re-export files — import directly from source
- Use `additionalRoutes` or `wrapHandler` — deprecated in Arc 2.8, use `routes` + `raw: true`
- Use `onRegister` + `createActionRouter` — use declarative `actions` on `defineResource()`
- Construct `{ success, data }` / `{ success: false, error }` envelopes — Arc 2.13 emits raw payloads; throw `ArcError` subclasses for failures
- Use `BadRequestError` from `#shared/utils/errors` as a separate class — it is now `ValidationError` re-exported from `@classytic/arc/utils`

## Testing

```bash
npm test                           # All tests (serial, MongoMemoryServer)
npx vitest run tests/integration/  # Integration only
FLOW_MODE=enterprise npx vitest run tests/integration/warehouse-advanced-e2e.test.ts
```

Tests use `setupBetterAuthOrg` + `createBetterAuthProvider` from `@classytic/arc/testing`. PlatformConfig must be seeded before app boot (loyalty plugin needs it).
