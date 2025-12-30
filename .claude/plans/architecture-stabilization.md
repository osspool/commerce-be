# Architecture Stabilization Plan

## Overview

Address the architect's review findings to create a modern, minimal, code-generative factory system with a strong reusable core.

---

## Phase 1: Critical Fixes (Security & Data Integrity)

### 1.1 Fix Duplicate Event Handler Registration [HIGH]

**Problem:** Event handlers register in BOTH API process and worker process when `WORKER_MODE=standalone`, causing duplicate emails, inventory moves, etc.

**Files:**
- `app.js` (lines 96-129)
- `core/worker/WorkerBootstrap.js` (lines 134-157)

**Solution:** Gate event handlers in app.js based on worker mode:

```javascript
// app.js - Section 7.6
// Only register event handlers if running in inline worker mode
// When WORKER_MODE=standalone, the worker process handles events exclusively
if (isInlineWorkerMode) {
  try {
    const stats = await eventRegistry.autoDiscoverEvents();
    fastify.log.info('Domain events auto-discovered', { ... });

    registerInventoryEventHandlers();
    fastify.log.info('Legacy inventory event handlers registered');
  } catch (error) {
    fastify.log.warn('Event auto-discovery failed', { error: error.message });
  }
} else {
  fastify.log.info({ mode: 'standalone' }, 'Event handlers disabled (running in standalone worker)');
}
```

**Config option (optional):** Add `API_ENABLE_EVENTS=false` override for edge cases.

---

### 1.2 Fix createActionRouter Authorization Gap [HIGH]

**Problem:** `globalAuth` only adds `authenticate` but not `authorize`. Actions without per-action roles become accessible to ANY authenticated user.

**File:** `core/factories/createActionRouter.js` (line 135-148)

**Current Code:**
```javascript
if (allRequiredRoles.size > 0) {
  preHandler.push(fastify.authenticate);
  // Don't add global authorize - we'll check per-action (BUG: no fallback!)
}
```

**Solution:** Enforce globalAuth roles when action has no specific permissions:

```javascript
// Build preHandlers
const preHandler = [];

// Collect all required roles
const allRequiredRoles = new Set(globalAuth);
Object.values(actionPermissions).forEach((roles) => {
  if (Array.isArray(roles)) roles.forEach((r) => allRequiredRoles.add(r));
});

if (allRequiredRoles.size > 0) {
  preHandler.push(fastify.authenticate);
}

// Inside handler, after action validation:
const requiredRoles = actionPermissions[action];
if (requiredRoles?.length) {
  // Action-specific permission check
  const hasRole = checkUserRoles(user, requiredRoles);
  if (!hasRole) { ... }
} else if (globalAuth.length > 0) {
  // NEW: Fall back to globalAuth if no action-specific roles
  const hasRole = checkUserRoles(user, globalAuth);
  if (!hasRole) {
    return reply.code(403).send({
      success: false,
      error: `Insufficient permissions for '${action}' action. Required: ${globalAuth.join(' or ')}`,
    });
  }
}
```

---

## Phase 2: Module Config Consolidation [MEDIUM]

### 2.1 Decision: Remove or Implement module.config.js

**Current State:** 5 module.config.js files exist but are never loaded/used.

**Recommendation:** Remove module.config.js files and consolidate metadata into ResourceDefinition.

**Rationale:**
- ResourceDefinition already contains: name, permissions, events, model, routes
- Module config duplicates this metadata without enforcement
- Single source of truth is better than two drifting sources

**Alternative:** If keeping module.config.js, implement ModuleRegistry loader:

```javascript
// core/module/ModuleRegistry.js
class ModuleRegistry {
  async loadAll() {
    const configs = await glob('modules/**/module.config.js');
    for (const configPath of configs) {
      const config = await import(configPath);
      this.validateDependencies(config);
      this.modules.set(config.name, config);
    }
    return this.sortByDependencies();
  }
}
```

**Action:** Delete these files if not implementing ModuleRegistry:
- `modules/auth/module.config.js`
- `modules/catalog/products/module.config.js`
- `modules/catalog/categories/module.config.js`
- `modules/inventory/module.config.js`
- `modules/sales/customers/module.config.js`

---

### 2.2 Add Dependencies to ResourceDefinition

**Problem:** `order.resource.js` declares dependencies but ResourceDefinition ignores them.

**Solution:** Wire dependencies into fastify-plugin:

```javascript
// core/factories/ResourceDefinition.js
class ResourceDefinition {
  constructor(config) {
    // ...existing code...
    this.dependencies = config.dependencies || [];
  }

  toPlugin() {
    const self = this;

    async function resourcePlugin(fastify, opts) {
      // ...existing route registration...
    }

    // Use fastify-plugin with dependencies
    return fp(resourcePlugin, {
      name: `resource:${this.name}`,
      dependencies: this.dependencies.map(dep =>
        dep.startsWith('resource:') ? dep : `resource:${dep}`
      ),
    });
  }
}

// Usage in order.resource.js
export default defineResource({
  name: 'order',
  dependencies: ['customer', 'product', 'branch'], // Enforced load order
  // ...
}).toPlugin();
```

---

## Phase 3: API Consistency [LOW]

### 3.1 Fix Logistics Route Prefix

**Problem:** Logistics routes registered outside `/api/v1`, complicating API evolution.

**File:** `app.js` (line 132-134)

**Current:**
```javascript
// 8. LOGISTICS (uses absolute paths, no prefix)
await fastify.register(logisticsPlugin);
```

**Solution:** Move under `/api/v1` prefix:

```javascript
// In routes/erp.index.js or app.js
await fastify.register(logisticsPlugin, { prefix: '/api/v1/logistics' });
```

**Update logistics.plugin.js:** Remove `/api/v1/logistics` from basePath since prefix handles it.

---

## Phase 4: Factory Pattern Standardization

### 4.1 Migration Path: createRoutes → ResourceDefinition

**Modules still using createRoutes directly (candidates for migration):**

| Module | Complexity | Migration Effort |
|--------|------------|------------------|
| analytics | Custom queries | Keep createRoutes |
| export | Custom streaming | Keep createRoutes |
| platform | Config only | Keep createRoutes |
| pos | Workflow-heavy | Keep createRoutes |
| logistics | Mixed CRUD + utility | Partial migration possible |

**Rule of thumb:**
- **Use ResourceDefinition:** Standard CRUD with optional extras
- **Use createRoutes:** Custom workflows, non-entity operations
- **Use createActionRouter:** State machine transitions

### 4.2 Standardize Route File Naming

**Rename for consistency:**
```
*.plugin.js → routes.js (when single route group)

analytics/analytics.plugin.js → analytics/routes.js
export/export.plugin.js → export/routes.js
platform/platform.plugin.js → platform/routes.js
pos/pos.plugin.js → pos/routes.js
logistics/logistics.plugin.js → logistics/routes.js
```

---

## Phase 5: Event System Cleanup

### 5.1 Standardize events.js Pattern

**Current patterns (inconsistent):**
```javascript
// Pattern A: Events + Handlers
export const events = { ... };
export const handlers = { ... };

// Pattern B: Events + Helper functions
export const events = { ... };
export function emitProductCreated(product) { ... }

// Pattern C: Manual handler registration
export function registerHandlers() { eventBus.on(...) }
```

**Standard pattern:**
```javascript
// modules/{module}/events.js
export const events = {
  'order:created': {
    description: 'Emitted when order is created',
    schema: { /* JSON Schema */ },
  },
};

export const handlers = {
  // Handle events from OTHER modules
  'payment:verified': async (payload) => {
    // Update order status
  },
};

// Emit in controllers/services (NOT in events.js):
// eventBus.emit('order:created', { orderId, ... });
```

### 5.2 Remove Legacy Handler Registration

**Delete after Phase 1.1 is complete:**
```javascript
// app.js - Remove this section
registerInventoryEventHandlers();
```

**Migrate to standard events.js pattern in:**
- `modules/inventory/inventory.handlers.js` → `modules/inventory/events.js`

---

## Implementation Order

```
Week 1: Phase 1 (Critical Fixes)
├── 1.1 Gate event handlers in app.js
├── 1.2 Fix createActionRouter authorization
└── Test: Verify no duplicate events, auth works

Week 2: Phase 2 (Module Config)
├── 2.1 Delete unused module.config.js files
├── 2.2 Add dependencies support to ResourceDefinition
└── Test: Plugin load order verified

Week 3: Phase 3-4 (Consistency)
├── 3.1 Move logistics under /api/v1
├── 4.2 Rename plugin files to routes.js
└── Test: API docs correct, routes work

Week 4: Phase 5 (Events)
├── 5.1 Standardize remaining events.js files
├── 5.2 Remove legacy handler registration
└── Test: All events flow correctly
```

---

## Metrics & Validation

### Before/After Comparison

| Metric | Before | After |
|--------|--------|-------|
| Duplicate event processing | Possible | Prevented |
| Unauthorized action access | Possible | Blocked |
| Unused metadata files | 5 | 0 |
| API prefix consistency | 95% | 100% |
| Factory pattern adoption | 56% | 70% |

### Validation Tests

```bash
# 1. Verify no duplicate events
WORKER_MODE=standalone npm run dev &
node worker.js &
# Trigger event, verify single execution

# 2. Verify authorization
curl -X POST /inventory/transfers/123/action \
  -H "Authorization: Bearer <user_token>" \
  -d '{"action": "approve"}'
# Should return 403 (user lacks admin role)

# 3. Verify plugin load order
# Add console.log to each resource toPlugin()
# Verify dependencies load before dependents
```

---

## Questions for Team

1. **Event handlers in API:** Should we add `API_ENABLE_EVENTS=true` override for development/testing?

2. **Module config:** Delete files or implement ModuleRegistry? (Recommendation: Delete)

3. **Logistics prefix:** Any frontend dependencies on `/logistics` paths without `/api/v1`?

4. **Timeline:** Is 4-week phased approach acceptable, or need faster critical fixes?
