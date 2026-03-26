/**
 * Auth Integration Tests — Better Auth + Arc
 *
 * Tests:
 * - Sign-up, sign-in, session validation
 * - Organization (branch) creation and management
 * - Member role assignment
 * - User profile endpoints
 * - RBAC (role-based access control)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupTestOrg,
  teardownTestOrg,
  authHeaders,
  safeParseBody,
  signUp,
  signIn,
  createOrg,
  setActiveOrg,
} from './helpers/setup.js';

let ctx;

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 30000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

// ============================================================================
// Auth Flow
// ============================================================================

describe('Auth Flow', () => {
  it('BA health endpoint returns ok', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/ok' });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.ok).toBe(true);
  });

  it('can sign up a new user', async () => {
    const result = await signUp(ctx.app, {
      email: 'newuser@test.com',
      password: 'password123',
      name: 'New User',
    });
    expect(result.statusCode).toBe(200);
    expect(result.token).toBeTruthy();
    expect(result.user?.email).toBe('newuser@test.com');
  });

  it('rejects duplicate email on sign-up', async () => {
    const result = await signUp(ctx.app, {
      email: 'admin@test.com',
      password: 'password123',
      name: 'Duplicate',
    });
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('can sign in with correct credentials', async () => {
    const result = await signIn(ctx.app, {
      email: 'admin@test.com',
      password: 'password123',
    });
    expect(result.statusCode).toBe(200);
    expect(result.token).toBeTruthy();
    expect(result.user?.email).toBe('admin@test.com');
  });

  it('rejects sign in with wrong password', async () => {
    const result = await signIn(ctx.app, {
      email: 'admin@test.com',
      password: 'wrongpassword',
    });
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('can get session with bearer token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: authHeaders(ctx.users.admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body?.user?.email).toBe('admin@test.com');
    expect(body?.session?.token).toBeTruthy();
  });

  it('rejects request without token', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// Organization (Branch) Management
// ============================================================================

describe('Organization (Branch)', () => {
  it('org was created during setup', () => {
    expect(ctx.orgId).toBeTruthy();
  });

  it('admin can list organizations', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/organization/list',
      headers: authHeaders(ctx.users.admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    // BA returns array or object with data
    const orgs = Array.isArray(body) ? body : body?.data || body?.organizations || [];
    expect(orgs.length).toBeGreaterThanOrEqual(1);
  });

  it('admin can create a second branch', async () => {
    const result = await createOrg(ctx.app, ctx.users.admin.token, {
      name: 'Second Branch',
      slug: 'second-branch',
    });
    expect(result.statusCode).toBe(200);
    expect(result.orgId).toBeTruthy();
  });

  it('admin can set active organization', async () => {
    const result = await setActiveOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    expect(result.statusCode).toBe(200);
  });
});

// ============================================================================
// User Profile
// ============================================================================

describe('User Profile', () => {
  it('authenticated user can get profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.success).toBe(true);
    expect(body.data?.email).toBe('admin@test.com');
    expect(body.data?.name).toBe('Admin User');
  });

  it('authenticated user can update profile name', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { name: 'Updated Admin' },
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.data?.name).toBe('Updated Admin');
  });

  it('unauthenticated user cannot access profile', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// Branch API (via /api/v1/branches)
// ============================================================================

describe('Branch API', () => {
  it('authenticated user can list branches (200 OK)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branches',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.success).toBe(true);
  });

  it('branch default endpoint returns a branch', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branches/default',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
    expect(body.data.name).toBeTruthy();
  });
});
