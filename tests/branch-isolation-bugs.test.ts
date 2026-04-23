/**
 * Branch Isolation Bugs — regression tests
 *
 * Reproduces cross-branch A/P and A/R leakage:
 *   openBillsHandler and openInvoicesHandler call getOpenItems() without
 *   organizationId, so every branch sees every branch's open items.
 *   getOpenItems({ organizationId }) is a top-level param on the ledger API.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('A/P and A/R: open items must scope to organizationId', () => {
  it('vendor-bill openBillsHandler passes organizationId to getOpenItems', () => {
    const src = readFileSync(
      'src/resources/accounting/vendor-bill/vendor-bill.resource.ts',
      'utf8',
    );
    const getOpenItemsCall = src.match(/getOpenItems\(\{[\s\S]*?\}\s*(?:as\s+\w+)?\)/);
    expect(getOpenItemsCall).not.toBeNull();
    expect(getOpenItemsCall![0]).toContain('organizationId');
  });

  it('customer-invoice openInvoicesHandler passes organizationId to getOpenItems', () => {
    const src = readFileSync(
      'src/resources/accounting/customer-invoice/customer-invoice.resource.ts',
      'utf8',
    );
    const getOpenItemsCall = src.match(/getOpenItems\(\{[\s\S]*?\}\s*(?:as\s+\w+)?\)/);
    expect(getOpenItemsCall).not.toBeNull();
    expect(getOpenItemsCall![0]).toContain('organizationId');
  });

  it('getOrgId helper is defined and used in vendor-bill handler', () => {
    const src = readFileSync(
      'src/resources/accounting/vendor-bill/vendor-bill.resource.ts',
      'utf8',
    );
    // getOrgId is defined but never called in the handler — that's the bug.
    // After fix: getOrgId(req) must appear inside openBillsHandler.
    const handlerBody = src.match(/async function openBillsHandler[\s\S]*?^}/m);
    expect(handlerBody).not.toBeNull();
    expect(handlerBody![0]).toContain('getOrgId');
  });

  it('getOrgId helper is defined and used in customer-invoice handler', () => {
    const src = readFileSync(
      'src/resources/accounting/customer-invoice/customer-invoice.resource.ts',
      'utf8',
    );
    const handlerBody = src.match(/async function openInvoicesHandler[\s\S]*?^}/m);
    expect(handlerBody).not.toBeNull();
    expect(handlerBody![0]).toContain('getOrgId');
  });
});
