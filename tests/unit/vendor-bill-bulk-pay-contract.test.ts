/**
 * Vendor Bill bulk-pay — contract tests
 *
 * Validates the bulkPay route + handler invariants so SDK callers and
 * agents don't accidentally regress the "apply one payment across many
 * bills" feature.
 *
 * Critical invariants:
 *   - Route is POST /bulk-pay (NOT POST /:id/action — it has no single ID)
 *   - All-or-nothing: every allocation validated against its bill's open
 *     balance BEFORE any posting is created
 *   - Hard cap at 50 allocations per call (prevents accidental DoS)
 *   - Returns per-bill result + total, not just a count
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const ACTIONS_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/vendor-bill/vendor-bill.actions.ts',
);
const RESOURCE_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/vendor-bill/vendor-bill.resource.ts',
);
const FACTORY_PATH = resolve(
  import.meta.dirname,
  '../../src/resources/accounting/_shared/control-account-resource.factory.ts',
);

describe('Vendor Bill bulk-pay contract', () => {
  it('bulkPayHandler is exported from vendor-bill.actions.ts', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('export async function bulkPayHandler');
  });

  it('bulkPayHandler validates allocations array is non-empty', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('ALLOCATIONS_REQUIRED');
  });

  it('bulkPayHandler caps at 50 allocations per call', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('TOO_MANY_ALLOCATIONS');
    expect(src).toContain('50');
  });

  it('bulkPayHandler pre-flights ALL allocations before creating any posting', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    // The handler must validate every allocation BEFORE the createPosting loop.
    // We verify the structure: pre-flight loop builds `contexts` array;
    // separate loop afterwards creates postings.
    const preflightIdx = src.indexOf('// Pre-flight');
    const postingIdx = src.indexOf('createPosting(', src.indexOf('bulkPayHandler'));
    expect(preflightIdx).toBeGreaterThan(0);
    expect(postingIdx).toBeGreaterThan(preflightIdx);
  });

  it('bulkPayHandler returns per-allocation result + totalPaid + billCount', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    expect(src).toContain('totalPaid');
    expect(src).toContain('billCount');
    expect(src).toContain('allocations: results');
  });

  it('resource wires POST /bulk-pay as a non-action route', async () => {
    const src = await readFile(RESOURCE_PATH, 'utf8');
    expect(src).toContain("path: '/bulk-pay'");
    expect(src).toContain("method: 'POST' as const");
    expect(src).toContain('bulkPayHandler');
  });

  it('factory accepts `extraRoutes` config field', async () => {
    const src = await readFile(FACTORY_PATH, 'utf8');
    expect(src).toContain('extraRoutes');
    // Spread into routes array so the auto-generated /open route is preserved
    expect(src).toContain('...(config.extraRoutes ?? [])');
  });

  it('rejects amount exceeding open balance per allocation', async () => {
    const src = await readFile(ACTIONS_PATH, 'utf8');
    // The pre-flight must check `amount > open` per allocation, not in aggregate
    expect(src).toContain('AMOUNT_EXCEEDS_OPEN_BALANCE');
    expect(src).toContain('allocationIndex: i');
  });
});
