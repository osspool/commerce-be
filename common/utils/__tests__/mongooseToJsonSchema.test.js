/**
 * Tests for mongooseToJsonSchema field rules
 * Run: node --test common/utils/__tests__/mongooseToJsonSchema.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from '@classytic/mongokit/utils';

describe('Field Rules', () => {
  const options = {
    fieldRules: {
      organizationId: { immutable: true },
      customerId: { immutable: true },
      type: { immutable: true },
      commission: { systemManaged: true },
      gateway: { systemManaged: true },
      metadata: { systemManaged: true },
    },
    update: {
      omitFields: ['category'], // Additional immutable field
    },
  };

  it('getImmutableFields: returns all immutable fields', () => {
    const immutable = getImmutableFields(options);
    assert.ok(immutable.includes('organizationId'));
    assert.ok(immutable.includes('customerId'));
    assert.ok(immutable.includes('type'));
    assert.ok(immutable.includes('category')); // From omitFields
    assert.strictEqual(immutable.includes('commission'), false);
  });

  it('getSystemManagedFields: returns system-managed fields', () => {
    const systemManaged = getSystemManagedFields(options);
    assert.ok(systemManaged.includes('commission'));
    assert.ok(systemManaged.includes('gateway'));
    assert.ok(systemManaged.includes('metadata'));
    assert.strictEqual(systemManaged.includes('organizationId'), false);
  });

  it('isFieldUpdateAllowed: checks field update permissions', () => {
    assert.strictEqual(isFieldUpdateAllowed('amount', options), true);
    assert.strictEqual(isFieldUpdateAllowed('status', options), true);
    assert.strictEqual(isFieldUpdateAllowed('organizationId', options), false);
    assert.strictEqual(isFieldUpdateAllowed('commission', options), false);
  });

  it('validateUpdateBody: validates update request', () => {
    const validBody = { amount: 1000, status: 'completed' };
    const result1 = validateUpdateBody(validBody, options);
    assert.strictEqual(result1.valid, true);
    assert.strictEqual(result1.violations.length, 0);

    const invalidBody = { organizationId: '123', commission: {} };
    const result2 = validateUpdateBody(invalidBody, options);
    assert.strictEqual(result2.valid, false);
    assert.strictEqual(result2.violations.length, 2);
    assert.strictEqual(result2.violations[0].field, 'organizationId');
    assert.strictEqual(result2.violations[1].field, 'commission');
  });

  it('validateUpdateBody: mixed valid and invalid fields', () => {
    const mixedBody = {
      amount: 1000,
      status: 'completed',
      organizationId: '123',
      metadata: {},
    };
    const result = validateUpdateBody(mixedBody, options);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.violations.length, 2);
  });
});

describe('Field Rules - Edge Cases', () => {
  it('handles empty options', () => {
    const immutable = getImmutableFields({});
    assert.strictEqual(immutable.length, 0);

    const systemManaged = getSystemManagedFields({});
    assert.strictEqual(systemManaged.length, 0);

    assert.strictEqual(isFieldUpdateAllowed('anyField', {}), true);

    const result = validateUpdateBody({ anyField: 'value' }, {});
    assert.strictEqual(result.valid, true);
  });

  it('handles missing fieldRules', () => {
    const options = {
      update: { omitFields: ['field1', 'field2'] },
    };
    const immutable = getImmutableFields(options);
    assert.strictEqual(immutable.length, 2);
    assert.ok(immutable.includes('field1'));
    assert.ok(immutable.includes('field2'));
  });

  it('handles immutableAfterCreate alias', () => {
    const options = {
      fieldRules: {
        userId: { immutableAfterCreate: true },
      },
    };
    const immutable = getImmutableFields(options);
    assert.ok(immutable.includes('userId'));
    assert.strictEqual(isFieldUpdateAllowed('userId', options), false);
  });
});

console.log('✅ All tests passed!');

