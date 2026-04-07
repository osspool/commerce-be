@../AGENTS.md

# be-prod — Backend API

## Stack

- **Fastify** via Arc 2.6.3 (`@classytic/arc`) — resource-oriented REST
- **MongoDB** via MongoKit 3.4 (`@classytic/mongokit`) — repository pattern + Mongoose
- **Better Auth 1.5.6** — bearer tokens, org-as-branch, `x-organization-id` scoping
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

```typescript
const myResource = defineResource({
  name: 'my-resource',
  prefix: '/inventory/my-resource',
  disableDefaultRoutes: true,
  additionalRoutes: [
    { method: 'GET', path: '/', permissions: permissions.inventory.view, wrapHandler: false,
      schema: mySchemas.list,
      handler: async (req, reply) => {
        const ctx = getFlowContext(req);
        const data = await flow().repositories.myRepo.list(ctx);
        return reply.send({ success: true, data });
      },
    },
  ],
});
```

## Testing

```bash
npm test                           # All tests (serial, MongoMemoryServer)
npx vitest run tests/integration/  # Integration only
FLOW_MODE=enterprise npx vitest run tests/integration/warehouse-advanced-e2e.test.ts
```

Tests use `setupBetterAuthOrg` + `createBetterAuthProvider` from `@classytic/arc/testing`. PlatformConfig must be seeded before app boot (loyalty plugin needs it).
