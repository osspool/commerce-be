# Fastify Plugins

## What is a Plugin?

In Fastify, **everything is a plugin**. A plugin is a function that:
1. Receives the Fastify instance
2. Adds functionality (decorators, hooks, routes)
3. Can depend on other plugins

```javascript
// Simple plugin example
async function myPlugin(fastify) {
  fastify.decorate('helper', () => 'hello');  // Now fastify.helper() exists everywhere
}
```

**Why plugins instead of just functions?**
- **Encapsulation** - Each plugin has its own scope
- **Dependencies** - Fastify ensures plugins load in correct order
- **Reusability** - Easy to share across projects
- **Testability** - Can test plugins in isolation

---

## Our Plugins

### Core Plugins (registered in `register-core-plugins.js`)

| Plugin | What it does | Decorates |
|--------|--------------|-----------|
| `auth.plugin.js` | JWT authentication & role-based authorization | `fastify.authenticate`, `fastify.authorize()` |
| `session.plugin.js` | Cookie-based sessions | `request.session` |
| `organization-scope.plugin.js` | Multi-tenant organization filtering | `instance.organizationScoped()` |
| `request-meta.plugin.js` | Initialize request context | `request.context`, `request.validated` |
| `response.plugin.js` | Response helpers | `reply.success()`, `reply.error()` |
| `cache.plugin.js` | Response caching | `createResponseCache()` |
| `schema-generator.plugin.js` | Auto-generate OpenAPI schemas | `fastify.generateSchemas()` |
| `empty-json.plugin.js` | Handle empty request bodies | (automatic) |

### Business Plugins (registered in `app.js`)

| Plugin | What it does | Decorates |
|--------|--------------|-----------|
| `revenue.plugin.js` | Stripe payments, transactions | `fastify.revenue`, `getRevenue()` |

### Mongokit Plugins (for repository pattern)

| Plugin | What it does |
|--------|--------------|
| `mongokit/organization-scope.plugin.js` | Auto-inject/filter organizationId in mongoose queries |

---

## Registration Order

**Order matters!** Plugins are registered in `register-core-plugins.js`:

```
1. Security     → helmet, cors, rate-limit
2. Parsing      → JWT, empty-json, schema-generator
3. Database     → mongoose
4. Auth         → auth.plugin (needs JWT)
5. Context      → session, request-meta, cache, response
6. Multi-tenant → organization-scope (needs auth)
```

---

## How to Use Plugins in Routes

```javascript
// Route requires authentication
{
  preHandler: [fastify.authenticate]
}

// Route requires specific role
{
  preHandler: [fastify.authenticate, fastify.authorize('admin')]
}

// Route requires organization context
{
  preHandler: [fastify.authenticate, instance.organizationScoped()]
}
```

---

## Why Revenue is a Plugin

The revenue system (Stripe payments) is a plugin because:

1. **Lifecycle management** - Initialized once when app starts
2. **Dependency order** - Must load after database is connected
3. **Decoration** - Makes `fastify.revenue` available everywhere
4. **Singleton access** - `getRevenue()` for use in workflows

```javascript
// In routes (has fastify context)
fastify.revenue.payments.create(...)

// In workflows (no fastify context)
import { getRevenue } from '#common/plugins/revenue.plugin.js';
getRevenue().payments.create(...)
```

---

## Adding a New Plugin

```javascript
// common/plugins/my-feature.plugin.js
import fp from 'fastify-plugin';

async function myFeaturePlugin(fastify) {
  // Add to fastify instance
  fastify.decorate('myFeature', {
    doSomething: () => { /* ... */ }
  });
  
  // Or add to every request
  fastify.decorateRequest('myData', null);
  fastify.addHook('onRequest', async (request) => {
    request.myData = await loadMyData();
  });
}

export default fp(myFeaturePlugin, {
  name: 'my-feature',
  dependencies: ['register-core-plugins'], // Optional: ensure order
});
```

Then register in `app.js`:
```javascript
await fastify.register(myFeaturePlugin);
```
