/**
 * Auth Permissions E2E Tests
 *
 * Tests: Invitations, multi-role members, RBAC, org lifecycle, member management.
 * Uses MongoMemoryServer — no real DB or SMTP.
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
  addMember,
  inviteMember,
  listMembers,
  getFullOrg,
  updateMemberRole,
  removeMember,
} from '../../support/test-org-setup.js';

let ctx;

beforeAll(async () => {
  // Suppress email sends during tests
  process.env.EMAIL_USER = '';
  process.env.EMAIL_PASS = '';
  ctx = await setupTestOrg();
}, 30000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

// ============================================================================
// A. Invitation Flow
// ============================================================================

describe('Invitation Flow', () => {
  it('admin can invite a new member', async () => {
    const result = await inviteMember(
      ctx.app,
      ctx.users.admin.token,
      ctx.orgId,
      'invited@test.com',
      'inventory_staff',
    );
    expect(result.statusCode).toBe(200);
  });

  it('rejects invitation with invalid email', async () => {
    const result = await inviteMember(
      ctx.app,
      ctx.users.admin.token,
      ctx.orgId,
      'not-an-email',
      'viewer',
    );
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('non-admin cannot invite members', async () => {
    const result = await inviteMember(
      ctx.app,
      ctx.users.cashier.token,
      ctx.orgId,
      'another@test.com',
      'viewer',
    );
    // Cashier should not have invite permission
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('admin can list pending invitations via full org', async () => {
    const result = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    expect(result.statusCode).toBe(200);
    const invitations = result.body?.invitations || [];
    expect(invitations.length).toBeGreaterThanOrEqual(1);
    const found = invitations.find((i) => i.email === 'invited@test.com');
    expect(found).toBeTruthy();
    expect(found.status).toBe('pending');
  });
});

// ============================================================================
// B. Multi-Role Members
// ============================================================================

describe('Multi-Role Members', () => {
  it('can assign multiple roles to a member via addMember', async () => {
    // Create a new user for this test
    const multiUser = await signUp(ctx.app, {
      email: 'multirole@test.com',
      password: 'password123',
      name: 'Multi Role User',
    });
    expect(multiUser.statusCode).toBe(200);

    const result = await addMember(ctx.auth, {
      organizationId: ctx.orgId,
      userId: multiUser.user?.id,
      role: ['branch_manager', 'inventory_staff'],
    });
    expect(result.statusCode).toBe(200);
  });

  it('member roles are stored and retrievable', async () => {
    const result = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    expect(result.statusCode).toBe(200);
    const members = result.body?.members || [];
    const multi = members.find((m) => m.user?.email === 'multirole@test.com');
    expect(multi).toBeTruthy();
    // BA stores multi-role as comma-separated string
    const roles = multi.role.split(',').map((r) => r.trim());
    expect(roles).toContain('branch_manager');
    expect(roles).toContain('inventory_staff');
  });

  it('can update member roles', async () => {
    const result = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    const members = result.body?.members || [];
    const multi = members.find((m) => m.user?.email === 'multirole@test.com');
    expect(multi).toBeTruthy();

    const update = await updateMemberRole(
      ctx.app,
      ctx.users.admin.token,
      multi.id,
      ['cashier', 'stock_receiver'],
    );
    expect(update.statusCode).toBe(200);
  });
});

// ============================================================================
// C. Permission Checks (RBAC)
// ============================================================================

describe('RBAC Permission Checks', () => {
  it('admin can access protected branch endpoints', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branches',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('cashier cannot access user management', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeaders(ctx.users.cashier.token, ctx.orgId),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('unauthenticated user gets 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { 'x-organization-id': ctx.orgId },
    });
    // Products list is public in this app, so check a protected endpoint
    const protectedRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
    });
    expect(protectedRes.statusCode).toBe(401);
  });

  it('admin can access branch endpoints', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/branches',
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(200);
  });

  it('staff can view but not create products', async () => {
    // View should work (public)
    const viewRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: authHeaders(ctx.users.staff.token, ctx.orgId),
    });
    expect(viewRes.statusCode).toBeLessThan(400);

    // Create should fail (requires storeAdmin)
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: authHeaders(ctx.users.staff.token, ctx.orgId),
      payload: { name: 'Test Product', basePrice: 100 },
    });
    expect(createRes.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ============================================================================
// D. Organization Lifecycle
// ============================================================================

describe('Organization Lifecycle', () => {
  let secondOrgId;

  it('admin can create a second branch', async () => {
    const result = await createOrg(ctx.app, ctx.users.admin.token, {
      name: 'Second Branch',
      slug: 'second-branch-perm',
    });
    expect(result.statusCode).toBe(200);
    expect(result.orgId).toBeTruthy();
    secondOrgId = result.orgId;
  });

  it('can set active organization', async () => {
    const result = await setActiveOrg(ctx.app, ctx.users.admin.token, secondOrgId);
    expect(result.statusCode).toBe(200);
  });

  it('branch additionalFields persist', async () => {
    const db = (await import('mongoose')).default.connection.getClient().db();
    await db.collection('organization').updateOne(
      { _id: new (await import('mongoose')).default.Types.ObjectId(secondOrgId) },
      {
        $set: {
          code: 'BR-002',
          branchType: 'warehouse',
          branchRole: 'sub_branch',
          isDefault: false,
          isActive: true,
        },
      },
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/organization/get-full-organization',
      headers: authHeaders(ctx.users.admin.token, secondOrgId),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    expect(body.code).toBe('BR-002');
    expect(body.branchType).toBe('warehouse');
    expect(body.branchRole).toBe('sub_branch');
  });

  it('can list user organizations', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/organization/list',
      headers: authHeaders(ctx.users.admin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = safeParseBody(res.body);
    const orgs = Array.isArray(body) ? body : body?.data || [];
    expect(orgs.length).toBeGreaterThanOrEqual(2);
  });

  // Switch back to main org for remaining tests
  it('switch back to main org', async () => {
    await setActiveOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
  });
});

// ============================================================================
// E. Member Management
// ============================================================================

describe('Member Management', () => {
  it('admin can list members of branch', async () => {
    const result = await listMembers(ctx.app, ctx.users.admin.token, ctx.orgId);
    expect(result.statusCode).toBe(200);
    const members = Array.isArray(result.body) ? result.body : result.body?.members || result.body?.data || [];
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  it('admin can update member role', async () => {
    const fullOrg = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    const members = fullOrg.body?.members || [];
    const staff = members.find((m) => m.user?.email === 'staff@test.com');
    expect(staff).toBeTruthy();

    const result = await updateMemberRole(
      ctx.app,
      ctx.users.admin.token,
      staff.id,
      'branch_manager',
    );
    expect(result.statusCode).toBe(200);
  });

  it('admin can remove a member', async () => {
    // Create a throwaway user to remove
    const throwaway = await signUp(ctx.app, {
      email: 'throwaway@test.com',
      password: 'password123',
      name: 'Throwaway User',
    });
    await addMember(ctx.auth, {
      organizationId: ctx.orgId,
      userId: throwaway.user?.id,
      role: 'viewer',
    });

    const fullOrg = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    const member = fullOrg.body?.members?.find((m) => m.user?.email === 'throwaway@test.com');
    expect(member).toBeTruthy();

    const result = await removeMember(ctx.app, ctx.users.admin.token, member.id);
    expect(result.statusCode).toBe(200);
  });

  it('org creator role matches config', async () => {
    // Admin created the org — should have creatorRole from config (branch_manager)
    const fullOrg = await getFullOrg(ctx.app, ctx.users.admin.token, ctx.orgId);
    const creator = fullOrg.body?.members?.find((m) => m.user?.email === 'admin@test.com');
    expect(creator).toBeTruthy();
    expect(creator.role).toContain('branch_manager');
  });
});
