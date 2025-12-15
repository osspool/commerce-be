# Field Rules Guide

Declarative field validation for Mongoose schema to JSON Schema conversion.

## Overview

Instead of manually managing `omitFields` in create/update schemas, use `fieldRules` for cleaner, self-documenting code.

## Field Rule Types

### 1. `immutable` / `immutableAfterCreate`
Field cannot be changed after creation (omitted from update schema).

```javascript
fieldRules: {
  organizationId: { immutable: true },
  userId: { immutableAfterCreate: true }, // Alias
}
```

**Use cases:**
- Primary keys: `organizationId`, `userId`, `customerId`
- Core identifiers: `type`, `category`, `referenceId`
- Business keys that shouldn't change

### 2. `systemManaged`
Field is managed by the system (omitted from both create and update schemas).

```javascript
fieldRules: {
  commission: { systemManaged: true },
  gateway: { systemManaged: true },
  verifiedAt: { systemManaged: true },
}
```

**Use cases:**
- Auto-calculated fields: `commission`, `balance`, `count`
- System timestamps: `verifiedAt`, `approvedAt`
- Integration data: `gateway`, `webhook`, `metadata`

### 3. `optional`
Make field optional (remove from required array).

```javascript
fieldRules: {
  status: { optional: true },
}
```

**Use cases:**
- Fields with defaults
- Optional metadata
- Conditional requirements handled elsewhere

## Usage Examples

### Example 1: Transaction Schema (Real)

```javascript
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

export const transactionSchemaOptions = {
  fieldRules: {
    // Immutable after creation
    organizationId: { immutable: true },
    customerId: { immutable: true },
    referenceId: { immutable: true },
    type: { immutable: true },
    category: { immutable: true },
    
    // System-managed
    commission: { systemManaged: true },
    gateway: { systemManaged: true },
    webhook: { systemManaged: true },
    verifiedAt: { systemManaged: true },
    metadata: { systemManaged: true },
  },
  create: {
    optionalOverrides: {
      type: true,    // Auto-derived
      status: true,  // Has default
    },
  },
};

const { crudSchemas } = buildCrudSchemasFromModel(Transaction, transactionSchemaOptions);
```

**Result:**
- Create schema: Allows all fields except `commission`, `gateway`, `webhook`, `verifiedAt`, `metadata`
- Update schema: Additionally blocks `organizationId`, `customerId`, `referenceId`, `type`, `category`

### Example 2: User Schema

```javascript
const { crudSchemas } = buildCrudSchemasFromModel(User, {
  fieldRules: {
    email: { immutable: true },           // Cannot change email
    role: { immutable: true },            // Role set at creation
    passwordHash: { systemManaged: true }, // Never exposed
    tokens: { systemManaged: true },      // System-only
    lastLoginAt: { systemManaged: true }, // Auto-updated
  },
  create: {
    omitFields: ['isVerified'],           // Set by verification flow
  },
});
```

### Example 3: Order Schema

```javascript
const { crudSchemas } = buildCrudSchemasFromModel(Order, {
  fieldRules: {
    orderId: { immutable: true },
    userId: { immutable: true },
    items: { immutable: true },           // Cannot change items
    totalAmount: { systemManaged: true }, // Auto-calculated
    commission: { systemManaged: true },  // Auto-calculated
    paymentGateway: { systemManaged: true },
    fulfilledAt: { systemManaged: true },
  },
});
```

## Controller Usage

Use helper functions for runtime validation:

```javascript
import {
  getImmutableFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from '@classytic/mongokit/utils';
import { transactionSchemaOptions } from './schemas.js';

class TransactionController extends BaseController {
  async update(req, reply) {
    // Quick validation
    const validation = validateUpdateBody(req.body, transactionSchemaOptions);
    if (!validation.valid) {
      return reply.code(400).send({
        success: false,
        error: 'Invalid fields',
        violations: validation.violations,
      });
    }

    // Or check individual fields
    if (!isFieldUpdateAllowed('organizationId', transactionSchemaOptions)) {
      return reply.code(403).send({
        success: false,
        error: 'organizationId is immutable',
      });
    }

    return super.update(req, reply);
  }
}
```

## Benefits

### Before (Manual)
```javascript
const { crudSchemas } = buildCrudSchemasFromModel(Transaction, {
  create: {
    omitFields: [
      'organizationId',
      'verifiedAt',
      'commission',
      'gateway',
      'webhook',
      'metadata',
    ],
  },
  update: {
    omitFields: [
      'organizationId',  // Duplicate!
      'customerId',
      'referenceId',
      'type',
      'category',
      'commission',      // Duplicate!
      'gateway',         // Duplicate!
      'webhook',         // Duplicate!
      'verifiedAt',      // Duplicate!
      'metadata',        // Duplicate!
    ],
  },
});
```

**Issues:**
- Duplication between create/update
- No semantic meaning (why is this omitted?)
- Easy to forget fields

### After (Declarative)
```javascript
const { crudSchemas } = buildCrudSchemasFromModel(Transaction, {
  fieldRules: {
    organizationId: { immutable: true },  // Clear intent
    customerId: { immutable: true },
    type: { immutable: true },
    
    commission: { systemManaged: true },  // Clear reason
    gateway: { systemManaged: true },
    webhook: { systemManaged: true },
  },
});
```

**Benefits:**
- DRY: Define once, auto-applied
- Clear intent: `immutable` vs `systemManaged`
- Self-documenting
- Reusable in controllers via helper functions

## Testing

```javascript
import {
  getImmutableFields,
  validateUpdateBody,
} from '@classytic/mongokit/utils';

// Test field rules
const immutable = getImmutableFields(schemaOptions);
assert.ok(immutable.includes('organizationId'));

// Test update validation
const result = validateUpdateBody(
  { organizationId: '123' },
  schemaOptions
);
assert.strictEqual(result.valid, false);
```

See `common/utils/__tests__/mongooseToJsonSchema.test.js` for full test suite.

## Migration Guide

### Step 1: Identify Patterns

Look for repeated fields in `create.omitFields` and `update.omitFields`:

```javascript
// Old
create: { omitFields: ['field1', 'field2', 'field3'] },
update: { omitFields: ['field1', 'field2', 'field3', 'field4'] },
```

### Step 2: Categorize

- Fields in **both** create and update → `systemManaged`
- Fields **only** in update → `immutable`
- Keep special cases in `omitFields`

### Step 3: Refactor

```javascript
// New
fieldRules: {
  field1: { systemManaged: true },
  field2: { systemManaged: true },
  field3: { systemManaged: true },
  field4: { immutable: true },
}
```

### Step 4: Verify

Run tests, check generated schemas match expected behavior.

## Best Practices

1. **Use fieldRules for patterns**: Immutability, system management
2. **Use omitFields for exceptions**: One-off cases, complex logic
3. **Export schema options**: Enable reuse in controllers
4. **Document special cases**: Comment complex business rules
5. **Test thoroughly**: Validate generated schemas

## API Reference

### `getImmutableFields(options)`
Returns array of immutable field names.

### `getSystemManagedFields(options)`
Returns array of system-managed field names.

### `isFieldUpdateAllowed(fieldName, options)`
Returns boolean: can this field be updated?

### `validateUpdateBody(body, options)`
Returns `{ valid: boolean, violations: Array }`.

## Notes

- `immutable` and `immutableAfterCreate` are equivalent
- `fieldRules` work alongside `omitFields` (both applied)
- Schema validation happens at Fastify level (first line of defense)
- Controller logic still needed for business rules (category-specific, status-dependent, etc.)

