/**
 * Permission Policy Tests
 *
 * Tests the core permission primitives (allowPublic, requireAuth, requireRoles,
 * allOf, anyOf, denyAll) and the resource-level permission map.
 *
 * Pure function tests — no database required.
 */

import { describe, it, expect } from 'vitest';
import {
  allowPublic,
  requireAuth,
  requireRoles,
  allOf,
  anyOf,
  denyAll,
  getResourcePermissions,
} from '#shared/permissions.js';
import { roles, groups } from '#config/permissions/roles.js';

// ---------------------------------------------------------------------------
// Helpers — build mock PermissionContext objects
// ---------------------------------------------------------------------------

type PermCtx = { user: { id: string; roles: string[] } | null; [k: string]: unknown };

function unauthCtx(): PermCtx {
  return { user: null };
}

function authCtx(userRoles: string | string[] = 'user'): PermCtx {
  return { user: { id: 'u_1', roles: Array.isArray(userRoles) ? userRoles : [userRoles] } };
}

/** Normalize a check result to { granted, reason? } */
function normalize(result: boolean | { granted: boolean; reason?: string }) {
  return typeof result === 'boolean' ? { granted: result } : result;
}

// ---------------------------------------------------------------------------
// allowPublic
// ---------------------------------------------------------------------------

describe('allowPublic()', () => {
  const check = allowPublic();

  it('grants access for unauthenticated context', () => {
    const result = normalize(check(unauthCtx()));
    expect(result.granted).toBe(true);
  });

  it('grants access for authenticated context', () => {
    const result = normalize(check(authCtx()));
    expect(result.granted).toBe(true);
  });

  it('grants access for admin context', () => {
    const result = normalize(check(authCtx('admin')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

describe('requireAuth()', () => {
  const check = requireAuth();

  it('denies unauthenticated requests', () => {
    const result = normalize(check(unauthCtx()));
    expect(result.granted).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('grants any authenticated user', () => {
    const result = normalize(check(authCtx()));
    expect(result.granted).toBe(true);
  });

  it('grants admin users', () => {
    const result = normalize(check(authCtx('admin')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireRoles
// ---------------------------------------------------------------------------

describe('requireRoles()', () => {
  const adminOnly = requireRoles([roles.ADMIN]);

  it('denies unauthenticated requests', () => {
    const result = normalize(adminOnly(unauthCtx()));
    expect(result.granted).toBe(false);
  });

  it('denies a user without the required role', () => {
    const result = normalize(adminOnly(authCtx('user')));
    expect(result.granted).toBe(false);
  });

  it('grants a user with the required role', () => {
    const result = normalize(adminOnly(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('grants when user has one of several accepted roles', () => {
    const adminOrSuperadmin = requireRoles([roles.ADMIN, roles.SUPERADMIN]);
    const result = normalize(adminOrSuperadmin(authCtx('superadmin')));
    expect(result.granted).toBe(true);
  });

  it('denies when user has none of the accepted roles', () => {
    const adminOrSuperadmin = requireRoles([roles.ADMIN, roles.SUPERADMIN]);
    const result = normalize(adminOrSuperadmin(authCtx('user')));
    expect(result.granted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allOf (AND combinator)
// ---------------------------------------------------------------------------

describe('allOf()', () => {
  const authAndAdmin = allOf(requireAuth(), requireRoles([roles.ADMIN]));

  it('denies unauthenticated (first check fails)', async () => {
    const result = normalize(await authAndAdmin(unauthCtx()));
    expect(result.granted).toBe(false);
  });

  it('denies authenticated non-admin (second check fails)', async () => {
    const result = normalize(await authAndAdmin(authCtx('user')));
    expect(result.granted).toBe(false);
  });

  it('grants when all checks pass', async () => {
    const result = normalize(await authAndAdmin(authCtx('admin')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// anyOf (OR combinator)
// ---------------------------------------------------------------------------

describe('anyOf()', () => {
  const adminOrSuperadmin = anyOf(requireRoles([roles.ADMIN]), requireRoles([roles.SUPERADMIN]));

  it('grants if first check passes', async () => {
    const result = normalize(await adminOrSuperadmin(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('grants if second check passes', async () => {
    const result = normalize(await adminOrSuperadmin(authCtx('superadmin')));
    expect(result.granted).toBe(true);
  });

  it('denies if neither check passes', async () => {
    const result = normalize(await adminOrSuperadmin(authCtx('user')));
    expect(result.granted).toBe(false);
  });

  it('denies unauthenticated', async () => {
    const result = normalize(await adminOrSuperadmin(unauthCtx()));
    expect(result.granted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// denyAll
// ---------------------------------------------------------------------------

describe('denyAll()', () => {
  it('denies unauthenticated', () => {
    const check = denyAll();
    const result = normalize(check(unauthCtx()));
    expect(result.granted).toBe(false);
  });

  it('denies admin', () => {
    const check = denyAll();
    const result = normalize(check(authCtx('superadmin')));
    expect(result.granted).toBe(false);
  });

  it('includes custom reason when provided', () => {
    const check = denyAll('Not allowed');
    const result = normalize(check(unauthCtx()));
    expect(result.granted).toBe(false);
    expect(result.reason).toBe('Not allowed');
  });
});

// ---------------------------------------------------------------------------
// Resource policy map — product
// ---------------------------------------------------------------------------

describe('Resource policies — product', () => {
  const perms = getResourcePermissions('product');

  it('allows public list', () => {
    const result = normalize(perms.list(unauthCtx()));
    expect(result.granted).toBe(true);
  });

  it('allows public get', () => {
    const result = normalize(perms.get(unauthCtx()));
    expect(result.granted).toBe(true);
  });

  it('denies unauthenticated create', () => {
    const result = normalize(perms.create(unauthCtx()));
    expect(result.granted).toBe(false);
  });

  it('denies regular user create', () => {
    const result = normalize(perms.create(authCtx('user')));
    expect(result.granted).toBe(false);
  });

  it('allows admin to create', () => {
    const result = normalize(perms.create(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('allows admin to update', () => {
    const result = normalize(perms.update(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('allows superadmin to delete', () => {
    const result = normalize(perms.delete(authCtx('superadmin')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resource policies — order (mixed permissions)
// ---------------------------------------------------------------------------

describe('Resource policies — order', () => {
  const perms = getResourcePermissions('order');

  it('denies unauthenticated order get', () => {
    const result = normalize(perms.get(unauthCtx()));
    expect(result.granted).toBe(false);
  });

  it('grants authenticated order get (requireAuth)', () => {
    const result = normalize(perms.get(authCtx('user')));
    expect(result.granted).toBe(true);
  });

  it('allows admin order create because create is any authenticated user', () => {
    const result = normalize(perms.create(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('grants user order create', () => {
    const result = normalize(perms.create(authCtx('user')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resource policies — user (restricted)
// ---------------------------------------------------------------------------

describe('Resource policies — user', () => {
  const perms = getResourcePermissions('user');

  it('denies regular user list', () => {
    const result = normalize(perms.list(authCtx('user')));
    expect(result.granted).toBe(false);
  });

  it('grants admin list (platformStaff)', () => {
    const result = normalize(perms.list(authCtx('admin')));
    expect(result.granted).toBe(true);
  });

  it('denies admin create (superadminOnly)', () => {
    const result = normalize(perms.create(authCtx('admin')));
    expect(result.granted).toBe(false);
  });

  it('grants superadmin create', () => {
    const result = normalize(perms.create(authCtx('superadmin')));
    expect(result.granted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getResourcePermissions — unknown resource
// ---------------------------------------------------------------------------

describe('getResourcePermissions()', () => {
  it('throws for unknown resource name', () => {
    expect(() => getResourcePermissions('nonexistent' as any)).toThrow('Unknown resource');
  });
});
