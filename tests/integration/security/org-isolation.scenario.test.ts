/**
 * Org isolation — scenario suite.
 *
 * Nike-BD architecture: every Better Auth org is a BRANCH within the ONE
 * company. `x-organization-id` scopes every API call. A user with a
 * membership in branch A must NOT be able to present branch B's id and
 * read branch B's data.
 *
 * This suite seeds a second branch (admin B), then attacks the scoping
 * layer from both directions:
 *
 *   - admin A sends admin B's `x-organization-id` header → must 401/403
 *     (membership check rejects)
 *   - admin A with no `x-organization-id` → must 401/403 on tenant-scoped
 *     routes (analytics/dashboard requires requireOrgMembership)
 *   - admin A reads /notifications/ scoped to branch A, then flips the
 *     header to branch B — notifications seeded for user A@branchA
 *     must not leak into the branch B response
 */

import type { FastifyInstance } from 'fastify';
import type { AuthProvider, TestOrgContext } from '@classytic/arc/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../helpers/scenario-setup.js';

const API = '/api/v1';

const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b) as Record<string, unknown>;
  } catch {
    return null;
  }
};

let envA: ScenarioEnv;
let server: FastifyInstance;
let authA: AuthProvider;
let adminAUserId: string;

let ctxB: TestOrgContext;
let authB: AuthProvider;
let orgB: string;

const hA = (): Record<string, string> => authA.getHeaders('admin');
const hB = (): Record<string, string> => authB.getHeaders('admin');

beforeAll(async () => {
  envA = await bootScenarioApp({ scenario: 'security-iso' });
  server = envA.server;
  authA = envA.auth;
  adminAUserId = envA.ctx.users.admin.userId;

  // Second branch — separate admin user, separate membership. Admin A
  // MUST NOT have any membership in this branch.
  const { setupBetterAuthOrg, createBetterAuthProvider } = await import('@classytic/arc/testing');
  const { getAuth } = await import('#resources/auth/auth.config.js');
  const ts = Date.now();
  ctxB = await setupBetterAuthOrg({
    createApp: () => Promise.resolve(server),
    org: { name: `IsoB-${ts}`, slug: `iso-b-${ts}` },
    users: [
      {
        key: 'admin',
        email: `iso-admin-b-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Iso Admin B',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });
  orgB = ctxB.orgId;
  await mongoose.connection.db!
    .collection('user')
    .updateOne({ email: ctxB.users.admin.email }, { $set: { role: ['admin'] } });
  const login = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ctxB.users.admin.email, password: 'TestPass123!' },
  });
  const token = (parse(login.body)?.token as string | undefined) ?? ctxB.users.admin.token;
  authB = createBetterAuthProvider({ tokens: { admin: token }, orgId: orgB, adminRole: 'admin' });
}, 180_000);

afterAll(async () => {
  if (envA) await envA.teardown();
}, 30_000);

describe('Org isolation — header forgery', () => {
  it('admin A presenting branch B id on /analytics/dashboard → 401/403', async () => {
    const headers = {
      ...hA(),
      'x-organization-id': orgB,
    };
    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=7d`,
      headers,
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('admin A with no x-organization-id → 401/403 on tenant-scoped route', async () => {
    const headers = hA();
    delete (headers as Record<string, string | undefined>)['x-organization-id'];

    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=7d`,
      headers,
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('admin A using own branch id → 200', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=7d`,
      headers: hA(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('admin B using own branch id → 200', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=7d`,
      headers: hB(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Org isolation — notifications do not leak across branches', () => {
  it('A seeds a notification in branch A; querying with branch B id returns zero', async () => {
    const NotificationModel = (await import('#resources/notifications/notification.model.js')).default;
    await NotificationModel.create({
      organizationId: envA.orgId,
      userId: adminAUserId,
      type: 'order.placed',
      title: 'A only',
      message: 'visible to A only',
      read: false,
      priority: 'normal',
    });

    // Admin A on branch A sees it.
    const selfRes = await server.inject({
      method: 'GET',
      url: `${API}/notifications/`,
      headers: hA(),
    });
    expect(selfRes.statusCode).toBe(200);
    const selfData = parse(selfRes.body)?.data as Array<{ title: string }>;
    expect(selfData.find((n) => n.title === 'A only')).toBeTruthy();

    // Admin A forging branch B id. The notifications resource currently
    // guards with requireAuth() (not requireOrgMembership), so the request
    // passes auth — but the repository filters on the presented org id,
    // so admin A's branch-A notification is NOT returned.
    //
    // KNOWN GAP (tracked in memory/security_gaps.md): tightening this to
    // requireOrgMembership would let us assert 401/403 here. Until then we
    // assert data non-leakage, which is the contract that matters.
    const forgedRes = await server.inject({
      method: 'GET',
      url: `${API}/notifications/`,
      headers: { ...hA(), 'x-organization-id': orgB },
    });
    if (forgedRes.statusCode === 200) {
      const forgedData = parse(forgedRes.body)?.data as Array<{ title: string }>;
      expect(forgedData.find((n) => n.title === 'A only')).toBeUndefined();
    } else {
      expect([401, 403]).toContain(forgedRes.statusCode);
    }

    // Admin B (legit member of branch B) sees nothing.
    const bRes = await server.inject({
      method: 'GET',
      url: `${API}/notifications/`,
      headers: hB(),
    });
    expect(bRes.statusCode).toBe(200);
    const bData = parse(bRes.body)?.data as Array<{ title: string }>;
    expect(bData.find((n) => n.title === 'A only')).toBeUndefined();
  });
});
