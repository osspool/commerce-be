/**
 * Shared Test Helpers — Better Auth + Arc Integration Tests
 *
 * Following the Arc testing pattern from example/arc/be/tests/helpers/setup.ts.
 * Uses MongoMemoryServer for isolated, fast tests.
 *
 * Usage:
 *   const ctx = await setupTestOrg();
 *   // ... run tests using ctx.app, ctx.users, ctx.orgId ...
 *   await teardownTestOrg(ctx);
 */

import { expect } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ============================================================================
// Request Helpers
// ============================================================================

export function safeParseBody(body) {
  try { return JSON.parse(body); } catch { return null; }
}

export function authHeaders(token, orgId) {
  const h = { authorization: `Bearer ${token}` };
  if (orgId) h['x-organization-id'] = orgId;
  return h;
}

export async function signUp(app, data) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: data,
  });
  const body = safeParseBody(res.body);
  const token = body?.token || '';
  return { statusCode: res.statusCode, token, user: body?.user || body, body };
}

/**
 * Mark a user's email as verified in the database.
 * Required because auth.config has requireEmailVerification: true.
 */
export async function verifyUserEmail(userId) {
  const mongoose = await import('mongoose');
  const db = mongoose.default.connection.getClient().db();
  const { ObjectId } = mongoose.default.Types;
  await db.collection('user').updateOne(
    { _id: new ObjectId(userId) },
    { $set: { emailVerified: true } },
  );
}

export async function signIn(app, data) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: data,
  });
  const body = safeParseBody(res.body);
  const token = body?.token || '';
  return { statusCode: res.statusCode, token, user: body?.user || body, body };
}

export async function createOrg(app, token, data) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: authHeaders(token),
    payload: data,
  });
  const body = safeParseBody(res.body);
  return { statusCode: res.statusCode, orgId: body?.id, body };
}

export async function setActiveOrg(app, token, orgId) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: authHeaders(token),
    payload: { organizationId: orgId },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function addMember(auth, data) {
  try {
    const result = await auth.api.addMember({ body: data });
    return { statusCode: 200, body: result };
  } catch (e) {
    return { statusCode: e.status || 500, body: e };
  }
}

// ============================================================================
// Invitation Helpers
// ============================================================================

export async function inviteMember(app, token, orgId, email, role) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/invite-member',
    headers: authHeaders(token, orgId),
    payload: { email, role, organizationId: orgId },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function cancelInvitation(app, token, invitationId) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/cancel-invitation',
    headers: authHeaders(token),
    payload: { invitationId },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function acceptInvitation(app, invitationId) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/accept-invitation',
    headers: {},
    payload: { invitationId },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

// ============================================================================
// Member Management Helpers
// ============================================================================

export async function listMembers(app, token, orgId) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/organization/list-members',
    headers: authHeaders(token, orgId),
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function getFullOrg(app, token, orgId) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/organization/get-full-organization',
    headers: authHeaders(token, orgId),
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function updateMemberRole(app, token, memberId, role) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/update-member-role',
    headers: authHeaders(token),
    payload: { memberId, role },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

export async function removeMember(app, token, memberIdOrEmail) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/remove-member',
    headers: authHeaders(token),
    payload: { memberIdOrEmail },
  });
  return { statusCode: res.statusCode, body: safeParseBody(res.body) };
}

// ============================================================================
// Full Org Setup — Commerce ERP
// ============================================================================

/**
 * Creates a complete test environment:
 * - MongoMemoryServer
 * - App instance with Better Auth
 * - 3 users: admin (branch_manager), staff (inventory_staff), cashier
 * - Organization (branch) with all members assigned roles
 */
export async function setupTestOrg() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  // Disconnect from per-suite-mongo if active, then connect to our own instance
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  // Set env vars BEFORE importing auth modules
  process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.BETTER_AUTH_URL = 'http://localhost:0';
  process.env.MONGO_URI = uri;

  // Reset auth singleton so it picks up the in-memory DB
  const { resetAuth } = await import('../../src/resources/auth/auth.config.js');
  resetAuth();

  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();

  const { createApplication } = await import('../../src/app.js');
  const app = await createApplication({ resources });
  await app.ready();

  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const auth = getAuth();
  const db = mongoose.connection.getClient().db();

  // Create users
  const adminSignup = await signUp(app, { email: 'admin@test.com', password: 'password123', name: 'Admin User' });
  expect(adminSignup.statusCode).toBe(200);

  const staffSignup = await signUp(app, { email: 'staff@test.com', password: 'password123', name: 'Staff User' });
  expect(staffSignup.statusCode).toBe(200);

  const cashierSignup = await signUp(app, { email: 'cashier@test.com', password: 'password123', name: 'Cashier User' });
  expect(cashierSignup.statusCode).toBe(200);

  // Verify emails + set roles before any sign-in (requireEmailVerification is enabled)
  await verifyUserEmail(adminSignup.user?.id);
  await verifyUserEmail(staffSignup.user?.id);
  await verifyUserEmail(cashierSignup.user?.id);

  const { ObjectId } = mongoose.Types;
  const userCol = db.collection('user');
  await userCol.updateOne({ _id: new ObjectId(adminSignup.user?.id) }, { $set: { role: ['admin', 'superadmin'] } });
  await userCol.updateOne({ _id: new ObjectId(staffSignup.user?.id) }, { $set: { role: ['store-staff'] } });
  await userCol.updateOne({ _id: new ObjectId(cashierSignup.user?.id) }, { $set: { role: ['store-staff'] } });

  // Re-login admin to get a token with verified session
  const adminLogin = await signIn(app, { email: 'admin@test.com', password: 'password123' });
  expect(adminLogin.statusCode).toBe(200);

  // Create branch (organization)
  const orgResult = await createOrg(app, adminLogin.token, {
    name: 'Test Branch',
    slug: 'test-branch',
  });
  expect(orgResult.statusCode).toBe(200);
  const orgId = orgResult.orgId;
  expect(orgId).toBeTruthy();

  // Set branch metadata
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { code: 'TEST-001', branchType: 'store', branchRole: 'head_office', isDefault: true, isActive: true } },
  );

  // Add members with branch roles
  expect((await addMember(auth, { organizationId: orgId, userId: staffSignup.user?.id, role: 'inventory_staff' })).statusCode).toBe(200);
  expect((await addMember(auth, { organizationId: orgId, userId: cashierSignup.user?.id, role: 'cashier' })).statusCode).toBe(200);

  // Set active org and re-login
  await setActiveOrg(app, adminLogin.token, orgId);

  const staffLogin = await signIn(app, { email: 'staff@test.com', password: 'password123' });
  await setActiveOrg(app, staffLogin.token, orgId);

  const cashierLogin = await signIn(app, { email: 'cashier@test.com', password: 'password123' });
  await setActiveOrg(app, cashierLogin.token, orgId);

  return {
    mongod,
    app,
    auth,
    orgId,
    users: {
      admin: { token: adminLogin.token, userId: adminSignup.user?.id },
      staff: { token: staffLogin.token, userId: staffSignup.user?.id },
      cashier: { token: cashierLogin.token, userId: cashierSignup.user?.id },
    },
  };
}

/**
 * Teardown the test environment.
 */
export async function teardownTestOrg(ctx) {
  await ctx?.app?.close();
  await mongoose.disconnect();
  await ctx?.mongod?.stop();
}
