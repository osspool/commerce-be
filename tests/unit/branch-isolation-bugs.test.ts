/**
 * Branch Isolation Bugs — regression tests
 *
 * A/P (vendor bills) and A/R (customer invoices) `/open` endpoints share
 * a single implementation in `_shared/control-account-resource.factory.ts`
 * (see `defineControlAccountResource`). The factory's `openItemsHandler`
 * is the choke point — both resources delegate to it. If branch isolation
 * regresses there, both A/P and A/R leak across branches.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FACTORY_PATH = 'src/resources/accounting/_shared/control-account-resource.factory.ts';

describe('A/P and A/R: open items must scope to organizationId', () => {
  it('factory openItemsHandler passes organizationId to getOpenItems', () => {
    const src = readFileSync(FACTORY_PATH, 'utf8');
    const getOpenItemsCall = src.match(/getOpenItems\(\{[\s\S]*?\}\s*(?:as\s+\w+)?\)/);
    expect(getOpenItemsCall).not.toBeNull();
    expect(getOpenItemsCall![0]).toContain('organizationId');
  });

  it('factory openItemsHandler reads orgId via getOrgId(req.scope)', () => {
    const src = readFileSync(FACTORY_PATH, 'utf8');
    const handlerBody = src.match(/async function openItemsHandler[\s\S]*?^\s{2}}/m);
    expect(handlerBody).not.toBeNull();
    expect(handlerBody![0]).toContain('getOrgId(req.scope)');
  });

  it('vendor-bill resource delegates to defineControlAccountResource', () => {
    const src = readFileSync(
      'src/resources/accounting/vendor-bill/vendor-bill.resource.ts',
      'utf8',
    );
    expect(src).toContain('defineControlAccountResource');
  });

  it('customer-invoice resource delegates to defineControlAccountResource', () => {
    const src = readFileSync(
      'src/resources/accounting/customer-invoice/customer-invoice.resource.ts',
      'utf8',
    );
    expect(src).toContain('defineControlAccountResource');
  });
});
