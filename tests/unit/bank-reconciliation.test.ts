/**
 * Bank Reconciliation — unit test (gap #5)
 *
 * Gap: No bank statement import or cash-to-bank matching workflow.
 * Fix: BankStatement model + bank-reconciliation resource with
 *      matchLine action + open-items route.
 *
 * RED: BankStatement model and resource don't exist
 * GREEN: create model, repository, resource
 */

import { describe, it, expect } from 'vitest';

describe('BankStatement model (gap #5)', () => {
  it('exposes the expected top-level schema paths', async () => {
    const { default: BankStatement } = await import(
      '../../src/resources/accounting/bank-reconciliation/bank-statement.model.js'
    );
    const schema = BankStatement.schema;
    expect(schema.path('organizationId')).toBeDefined();
    expect(schema.path('bankAccountId')).toBeDefined();
    expect(schema.path('bankAccountCode')).toBeDefined();
    expect(schema.path('statementDate')).toBeDefined();
    expect(schema.path('status')).toBeDefined();
    expect(schema.path('lines')).toBeDefined();
  });

  it('status field defaults to draft', async () => {
    const { default: BankStatement } = await import(
      '../../src/resources/accounting/bank-reconciliation/bank-statement.model.js'
    );
    const path = BankStatement.schema.path('status') as { defaultValue?: unknown };
    expect(path.defaultValue).toBe('draft');
  });

  it('lines items have matchingNumber field for JE reconciliation link', async () => {
    const { default: BankStatement } = await import(
      '../../src/resources/accounting/bank-reconciliation/bank-statement.model.js'
    );
    const linesPath = BankStatement.schema.path('lines') as { schema?: { path: (k: string) => unknown } };
    expect(linesPath.schema?.path('matchingNumber')).toBeDefined();
    expect(linesPath.schema?.path('jeEntryId')).toBeDefined();
    expect(linesPath.schema?.path('jeItemIndex')).toBeDefined();
  });
});
