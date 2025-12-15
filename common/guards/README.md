# Guards

Reusable authorization middleware for Fastify routes.

## Available Guards

- **organizationOwnerGuard** - Ensures user owns the organization
- **ownershipGuard** - Validates resource ownership

## Usage

```javascript
import { organizationOwnerGuard, ownershipGuard } from '#common/guards';
import Model from './model.js';

fastify.delete('/resource/:id', {
  preHandler: [
    fastify.authenticate,
    organizationOwnerGuard(),
    ownershipGuard({ Model })
  ]
}, handler);
```

## Pattern

All guards are factory functions returning async middleware:

export function myGuard(options = {}) {
  return async function (request, reply) {
    if (!authorized) throw createError(403, 'Forbidden');
  };
}