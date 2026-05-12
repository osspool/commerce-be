/**
 * Bank Reconciliation — contract tests
 *
 * Validates that the resource's action handlers and route handlers have the
 * correct shape so SDK callers don't get silent 404/500 surprises.
 *
 * These are source-code contract tests (no DB needed) — they parse the
 * resource definition file and assert on structural invariants.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const RESOURCE_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/bank-reconciliation/bank-reconciliation.resource.ts',
);

const MODEL_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/bank-reconciliation/bank-statement.model.ts',
);

describe('BankReconciliation resource contract', () => {
  it('resource prefix matches SDK baseUrl /accounting/bank-reconciliation', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain("prefix: '/accounting/bank-reconciliation'");
  });

  it('matchLine action exists and accepts lineIndex + jeEntryId + jeItemIndex + jeAccountId', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain('matchLine:');
    expect(src).toContain('lineIndex');
    expect(src).toContain('jeEntryId');
    expect(src).toContain('jeItemIndex');
    expect(src).toContain('jeAccountId');
  });

  it('unmatchLine action exists and accepts lineIndex', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain('unmatchLine:');
    expect(src).toContain('lineIndex');
  });

  it('GET /open-items route exists and accepts bankAccountCode param', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain("path: '/open-items'");
    expect(src).toContain('bankAccountCode');
  });

  it('matchLine returns { matchingNumber } — matches SDK MatchLineResult type', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain('matchingNumber: recn');
  });

  it('model has required fields the SDK types expose', async () => {
    const src = await readFile(MODEL_PATH, 'utf8');
    expect(src).toContain('bankAccountCode');
    expect(src).toContain('statementDate');
    expect(src).toContain('openingBalance');
    expect(src).toContain('closingBalance');
    expect(src).toContain("status: { type: String, enum: ['draft', 'reconciled']");
    expect(src).toContain('lines');
  });
});
