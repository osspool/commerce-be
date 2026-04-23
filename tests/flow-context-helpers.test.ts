/**
 * Unit tests for getFlowContext.
 *
 * Regression guard: a previous version only read `req.user.organizationId`
 * (which Better Auth/arc never populate — org lives on `req.scope`). When
 * the FE didn't send `x-organization-id` explicitly, organizationId fell
 * through to '' and Flow's `toOrgId('')` threw BSONError 500.
 *
 * Contract:
 *   1. Prefer req.scope (arc/Better Auth populates this)
 *   2. Fall back to req.user, then x-organization-id header
 *   3. If nothing resolves → throw 400, never return ''
 *   4. actorId and roles also come from scope first
 *   5. idempotency-key header is passed through
 */
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getFlowContext } from '../src/resources/inventory/flow/context-helpers.js';

type PartialReq = {
  scope?: { organizationId?: string; userId?: string; orgRoles?: string[] };
  user?: { id?: string; organizationId?: string; orgId?: string; roles?: string[] };
  headers?: Record<string, string | undefined>;
};

function mkReq(r: PartialReq): FastifyRequest {
  return { headers: {}, ...r } as unknown as FastifyRequest;
}

describe('getFlowContext', () => {
  const BRANCH = '507f1f77bcf86cd799439011';

  it('prefers req.scope.organizationId (arc/Better Auth path)', () => {
    const ctx = getFlowContext(mkReq({
      scope: { organizationId: BRANCH, userId: 'u1', orgRoles: ['admin'] },
      user: { organizationId: 'wrong', roles: ['staff'] },
      headers: { 'x-organization-id': 'also-wrong' },
    }));
    expect(ctx.organizationId).toBe(BRANCH);
    expect(ctx.actorId).toBe('u1');
    expect(ctx.roles).toEqual(['admin']);
  });

  it('falls back to req.user.organizationId when scope missing', () => {
    const ctx = getFlowContext(mkReq({
      user: { id: 'u2', organizationId: BRANCH, roles: ['cashier'] },
    }));
    expect(ctx.organizationId).toBe(BRANCH);
    expect(ctx.actorId).toBe('u2');
    expect(ctx.roles).toEqual(['cashier']);
  });

  it('falls back to req.user.orgId alias', () => {
    const ctx = getFlowContext(mkReq({ user: { orgId: BRANCH } }));
    expect(ctx.organizationId).toBe(BRANCH);
  });

  it('falls back to x-organization-id header when scope+user missing', () => {
    const ctx = getFlowContext(mkReq({ headers: { 'x-organization-id': BRANCH } }));
    expect(ctx.organizationId).toBe(BRANCH);
    expect(ctx.actorId).toBe('system');
  });

  it('throws 400 when no organization context is present (regression: must not return empty string)', () => {
    expect(() => getFlowContext(mkReq({}))).toThrowError(/organization context/i);
    try {
      getFlowContext(mkReq({}));
    } catch (e: any) {
      expect(e.statusCode).toBe(400);
    }
  });

  it('throws 400 when scope/user/header all empty strings (regression: BSONError from toOrgId(""))', () => {
    expect(() =>
      getFlowContext(mkReq({
        scope: { organizationId: '' },
        user: { organizationId: '' },
        headers: { 'x-organization-id': '' },
      })),
    ).toThrowError(/organization context/i);
  });

  it('passes idempotency-key header through', () => {
    const ctx = getFlowContext(mkReq({
      scope: { organizationId: BRANCH },
      headers: { 'idempotency-key': 'abc-123' },
    }));
    expect(ctx.idempotencyKey).toBe('abc-123');
  });

  it('defaults actorId to "system" and roles to [] when scope/user omit them', () => {
    const ctx = getFlowContext(mkReq({ scope: { organizationId: BRANCH } }));
    expect(ctx.actorId).toBe('system');
    expect(ctx.roles).toEqual([]);
  });
});
