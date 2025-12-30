# 🔐 Permissions Architecture Guide

## Overview

The `permissions.js` file is the **single source of truth** for all authorization decisions across the application. It uses a simple, flat role-based model without complex hierarchies.

## Role Definitions

```javascript
const platformStaff = ['admin', 'manager', 'superadmin'];
const authenticated = ['user', 'admin', 'manager', 'superadmin'];
```

- **user**: Regular authenticated users (can create organizations, enroll, order)
- **admin/manager**: Platform staff (monitor all organizations)
- **superadmin**: Full platform control

## Permission Structure

Each module has permissions defined as:

```javascript
moduleName: {
  // Standard CRUD operations (used by createCrudRouter)
  list: authenticated,
  get: authenticated,
  create: authenticated,
  update: authenticated,
  remove: platformStaff,

  // Custom operations (e.g., monetization workflows)
  renew: authenticated,
  pause: authenticated,
  cancel: authenticated,
  refund: platformStaff,
}
```

## Usage Patterns

### 1. CRUD Routes with `createCrudRouter`

```javascript
import permissions from '#config/permissions.js';

createCrudRouter(instance, controller, {
  tag: 'Order',
  auth: permissions.orders,  // ✅ Pass entire object
  // ...
});
```

**How it works:**
- `auth.list` → Applied to GET /
- `auth.get` → Applied to GET /:id
- `auth.create` → Applied to POST /
- `auth.update` → Applied to PATCH /:id
- `auth.remove` → Applied to DELETE /:id

### 2. Additional Routes in `createCrudRouter`

```javascript
createCrudRouter(instance, controller, {
  tag: 'Order',
  auth: permissions.orders,
  additionalRoutes: [
    {
      method: 'post',
      path: '/:orderId/renew',
      handler: renewHandler,
      authRoles: permissions.orders.renew,  // ✅ Pass array directly
    }
  ]
});
```

### 3. Route Composers (Monetization Framework)

```javascript
// Note: Route composition helpers have been removed.
// Register routes manually in plugin files.
// See modules/subscription/subscription.plugin.js for example

instance.post('/:orderId/renew', {
  schema: {
    tags: ['Orders'],
    summary: 'Renew order',
  },
  onRequest: instance.authenticate(permissions.orders.renew),
}, renewOrderHandler);
```

### 4. Direct Fastify Routes

```javascript
// Spread the array when using fastify.authorize directly
const baseAuth = [
  fastify.authenticate,
  fastify.authorize(...permissions.analytics.overview),  // ✅ Spread operator
  fastify.organizationScoped(),
];

fastify.get('/overview', { preHandler: baseAuth }, handler);
```

## Adding New Permissions

### For New Modules

1. Add to `permissions.js`:

```javascript
export default {
  // ... existing modules

  newModule: {
    list: authenticated,
    get: authenticated,
    create: authenticated,
    update: authenticated,
    remove: platformStaff,
  },
};
```

2. Use in plugin:

```javascript
createCrudRouter(instance, controller, {
  auth: permissions.newModule,
  // ...
});
```

### For New Operations (e.g., workflow actions)

1. Add to existing module in `permissions.js`:

```javascript
orders: {
  list: authenticated,
  get: authenticated,
  // ... existing CRUD

  // New custom operation
  approve: platformStaff,  // ✅ Only staff can approve
},
```

2. Use in route:

```javascript
{
  method: 'post',
  path: '/:orderId/approve',
  handler: approveHandler,
  authRoles: permissions.orders.approve,  // ✅ References new permission
}
```

## Security Best Practices

### ✅ DO

```javascript
// Use centralized permissions
authRoles: permissions.orders.renew

// Apply organization scoping
middlewares: [instance.organizationScoped()]

// Use spread operator for direct authorize
fastify.authorize(...permissions.orders.renew)
```

### ❌ DON'T

```javascript
// Hardcode role arrays (defeats centralization)
authRoles: ['user', 'admin', 'superadmin']

// Mix permission sources
authRoles: someCondition ? permissions.orders.renew : ['user']

// Forget ownership middlewares
// Missing: middlewares: [instance.organizationScoped()]
```

## Current Modules with Custom Operations

### Orders
- `renew`, `pause`, `resume`, `cancel` (authenticated)
- `refund`, `fulfill` (platformStaff)
- `cancelPurchase` (authenticated)

### Enrollments
- `renew`, `pause`, `resume`, `cancel` (authenticated)

### Subscriptions (Platform Billing)
- `renew`, `pause`, `resume`, `cancel` (authenticated)

## Verification

Test your changes:

```bash
# Verify syntax
node --check config/permissions.js
node --check modules/your-module/your-plugin.js

# Check all permissions are arrays
# Each value should be an array like ['user', 'admin']
```

## Migration Checklist

When updating a module to use centralized permissions:

- [ ] Remove hardcoded role arrays
- [ ] Import `permissions` from `#config/permissions.js`
- [ ] Update CRUD auth: `auth: permissions.moduleName`
- [ ] Update custom routes: `authRoles: permissions.moduleName.operation`
- [ ] Verify ownership middlewares are present
- [ ] Run syntax checks
- [ ] Test authorization manually or with tests

## Common Patterns

### Public Routes (No Auth)
```javascript
orders: {
  create: [],  // ✅ Guest checkout
}
```

### Authenticated Only
```javascript
enrollments: {
  list: authenticated,  // Any logged-in user
}
```

### Admin Only
```javascript
users: {
  remove: ['superadmin'],  // Only superadmin
}
```

### Mixed (CRUD public, custom auth)
```javascript
landingPages: {
  list: [],              // Public browsing
  get: [],               // Public viewing
  create: authenticated, // Auth required to create
}
```

## Architecture Benefits

1. **Single Source of Truth**: All auth decisions in one place
2. **Easy Auditing**: See all permissions at a glance
3. **Simple Updates**: Change role requirements globally
4. **Consistent**: Same pattern everywhere
5. **Self-Documenting**: Clear what each role can do
6. **Type-Safe**: IDEs autocomplete permission keys

## Questions?

See:
- `config/permissions.js` - All permission definitions
- `core/factories/createCrudRouter.js` - How CRUD auth works
- `lib/monetization/helpers/route-composer.js` - How custom routes work
- This guide - Architecture patterns
