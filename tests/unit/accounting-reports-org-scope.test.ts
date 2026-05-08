/**
 * Unit test for the strict branch-scope guard on report handlers.
 *
 * Background — silent cross-branch leakage was a HIGH-severity blocker:
 * if `req.scope.organizationId` is missing on a `raw: true` report route,
 * the underlying ledger aggregation drops the org filter and silently
 * returns ALL-branches numbers. The fix introduces `requireOrgId()` which
 * throws a `ValidationError` instead of silently aggregating. This test
 * pins that behavior so a future regression to the permissive form is
 * caught at unit-test time, not in a customer's wrong P&L.
 */

import { describe, it, expect } from 'vitest';
import { ValidationError } from '@classytic/arc/utils';
import { requireOrgId } from '../../src/resources/accounting/reports/reports.handlers.js';

type Source = 'scope' | 'query' | 'header' | 'none';

function buildReq(source: Source, value = 'org-id-123') {
  return {
    headers: source === 'header' ? { 'x-organization-id': value } : {},
    scope: source === 'scope' ? { organizationId: value } : undefined,
    query: source === 'query' ? { branchId: value } : {},
  } as Parameters<typeof requireOrgId>[0];
}

describe('requireOrgId — strict org scope guard for report routes', () => {
  it('returns org id when present in req.scope (BA adapter case)', () => {
    expect(requireOrgId(buildReq('scope'))).toBe('org-id-123');
  });

  it('returns org id from ?branchId fallback (superadmin case)', () => {
    expect(requireOrgId(buildReq('query'))).toBe('org-id-123');
  });

  it('returns org id from x-organization-id header fallback', () => {
    expect(requireOrgId(buildReq('header'))).toBe('org-id-123');
  });

  it('throws ValidationError when no source produces an id', () => {
    expect(() => requireOrgId(buildReq('none'))).toThrow(ValidationError);
  });

  it('error message references branch isolation explicitly', () => {
    try {
      requireOrgId(buildReq('none'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/branch-scoped|cross-branch leakage/i);
    }
  });

  it('does NOT silently default to undefined when scope is empty object', () => {
    const empty = { headers: {}, scope: {}, query: {} } as Parameters<typeof requireOrgId>[0];
    expect(() => requireOrgId(empty)).toThrow(ValidationError);
  });

  it('scope wins over query and header when all three present', () => {
    const req = {
      headers: { 'x-organization-id': 'header-org' },
      scope: { organizationId: 'scope-org' },
      query: { branchId: 'query-org' },
    } as Parameters<typeof requireOrgId>[0];
    expect(requireOrgId(req)).toBe('scope-org');
  });

  it('query beats header when scope is empty', () => {
    const req = {
      headers: { 'x-organization-id': 'header-org' },
      scope: undefined,
      query: { branchId: 'query-org' },
    } as Parameters<typeof requireOrgId>[0];
    expect(requireOrgId(req)).toBe('query-org');
  });
});
