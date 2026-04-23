/**
 * Scenario Setup — shared boot/teardown for scenario-style integration tests.
 *
 * Mirrors the pattern used by the existing order-concurrency and
 * accounting-lifecycle scenarios, pulled into one helper to keep new
 * scenarios focused on "setup → drive → assert" not "60 lines of Better
 * Auth plumbing."
 *
 * Intentionally keeps each scenario's own data seeding (products, stock,
 * accounts) in the test file — the helper only covers the stuff every
 * scenario needs (platform config, Arc app, admin user, Flow engine
 * boot, event spy).
 */

import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  safeParseBody,
  type AuthProvider,
  type TestOrgContext,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

export interface ScenarioEnv {
  replSet: MongoMemoryReplSet;
  server: FastifyInstance;
  ctx: TestOrgContext;
  auth: AuthProvider;
  orgId: string;
  teardown: () => Promise<void>;
}

/**
 * Narrow Arc's `safeParseBody` (which returns `any`) to a JSON object or
 * `null`. Re-exported so scenario tests can `import { parse } from
 * '../helpers/scenario-setup.js'` instead of reimplementing the JSON.parse
 * try/catch in every file.
 */
export const parse = (body: string): Record<string, unknown> | null =>
  safeParseBody(body) as Record<string, unknown> | null;

async function seedPlatformConfig(storeName: string): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName,
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Boot a full Arc app backed by a MongoMemoryReplSet (required for
 * transactional operations used by the order saga + Flow reservations).
 *
 * Pass `env` to override defaults — e.g. `ENABLE_ACCOUNTING=true` for
 * scenarios that exercise the accounting event handlers.
 */
export async function bootScenarioApp(opts: {
  scenario: string;
  env?: Record<string, string>;
  extraOrgUpdate?: Record<string, unknown>;
}): Promise<ScenarioEnv> {
  // Base test env — individual scenarios layer their own on top.
  process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
  process.env.BETTER_AUTH_URL = 'http://localhost:0';
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.FLOW_MODE ??= 'simple';
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }
  await seedPlatformConfig(opts.scenario);

  // Promo + cart engines are referenced at resource-load time.
  // tenant:false mirrors production plugin — arc is the tenant boundary,
  // mongokit's multiTenantPlugin stays off. Schema still has organizationId
  // (promo's injectTenantField adds it unconditionally).
  const { createPromoEngine } = await import('@classytic/promo');
  const { setPromoEngine } = await import('#resources/promotions/promo.plugin.js');
  setPromoEngine(createPromoEngine({ mongoose: mongoose.connection, tenant: false }));
  const { initCartEngine } = await import('#resources/sales/cart/cart.engine.js');
  await initCartEngine();

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `${opts.scenario}-admin-${ts}@test.com`;

  const ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: resources as never }),
    org: { name: `${opts.scenario}-${ts}`, slug: `${opts.scenario}-${ts}` },
    users: [
      {
        key: 'admin', email: adminEmail, password: 'TestPass123!',
        name: `${opts.scenario} Admin`, role: 'admin', isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne({ email: adminEmail }, { $set: { role: ['admin'] } });

  // Refresh admin token post-role-promotion so the session reflects admin role.
  const loginRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;

  const auth = createBetterAuthProvider({
    tokens: { admin: token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    {
      $set: {
        role: 'head_office', code: `${opts.scenario.slice(0, 4).toUpperCase()}-HO`,
        branchType: 'store', branchRole: 'head_office',
        isDefault: true, isActive: true,
        ...opts.extraOrgUpdate,
      },
    },
  );

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch } = await import('./erp-seed.js');
  await setupBranch(getFlowEngine(), ctx.orgId);

  return {
    replSet,
    server: ctx.app,
    ctx,
    auth,
    orgId: ctx.orgId,
    teardown: async () => {
      try { await ctx.app.close(); } catch { /* already closed */ }
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      await replSet.stop();
    },
  };
}

/**
 * Provision a second branch with its OWN admin user (distinct from the
 * primary admin). Use this when your scenario asserts cross-branch 403
 * isolation — `addSecondaryBranch` puts both orgs under the same admin
 * which neutralizes membership-based isolation checks.
 *
 * Returns the new branch's orgId plus a fresh `AuthProvider` that holds the
 * outlet admin's bearer token. Each admin's Better-Auth session has its
 * own `activeOrganizationId`, so no per-request `set-active` juggling is
 * needed — each auth provider stays pinned to its own branch.
 */
export async function addSecondaryBranchWithOwnAdmin(
  env: ScenarioEnv,
  opts: {
    slug: string;
    name?: string;
    branchRole?: string;
    branchType?: 'warehouse' | 'store';
    /** User-level role array written onto the Better-Auth user doc. */
    roles?: string[];
    /** Label for the auth provider's adminRole (used by HttpTestHarness). */
    adminRoleLabel?: string;
  },
): Promise<{ orgId: string; auth: AuthProvider; token: string; email: string }> {
  const ts = Date.now();
  const email = `${opts.slug}-admin-${ts}@test.com`;
  const password = 'TestPass123!';

  const signUpRes = await env.server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name: `${opts.name ?? opts.slug} Admin` },
  });
  const signUpBody = parse(signUpRes.body);
  const userId = (signUpBody?.user as { id?: string } | undefined)?.id
    ?? (signUpBody as { id?: string } | null)?.id;
  if (!userId) throw new Error(`Failed to sign up secondary admin: ${signUpRes.body}`);

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(userId) },
    { $set: { emailVerified: true, role: opts.roles ?? ['admin'] } },
  );

  const signInRes = await env.server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  const token = (parse(signInRes.body)?.token as string | undefined)
    ?? (signUpBody?.token as string | undefined);
  if (!token) throw new Error(`Failed to sign in secondary admin: ${signInRes.body}`);

  const authHeaders = { authorization: `Bearer ${token}` } as Record<string, string>;

  const createOrgRes = await env.server.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: authHeaders,
    payload: { name: opts.name ?? opts.slug, slug: `${opts.slug}-${ts}` },
  });
  const newOrgId = (parse(createOrgRes.body) as { id?: string } | null)?.id;
  if (!newOrgId) throw new Error(`Failed to create secondary branch: ${createOrgRes.body}`);

  await env.server.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: authHeaders,
    payload: { organizationId: newOrgId },
  });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(newOrgId) },
    {
      $set: {
        code: opts.slug.toUpperCase().slice(0, 10),
        branchType: opts.branchType ?? 'store',
        branchRole: opts.branchRole ?? 'branch',
        isDefault: false,
        isActive: true,
      },
    },
  );

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch } = await import('./erp-seed.js');
  await setupBranch(getFlowEngine(), newOrgId);

  const auth = createBetterAuthProvider({
    tokens: { admin: token },
    orgId: newOrgId,
    adminRole: opts.adminRoleLabel ?? opts.roles?.[0] ?? 'admin',
  });

  return { orgId: newOrgId, auth, token, email };
}

/**
 * Seed a Better-Auth organization as a second branch under the same user.
 * Returns the new branch's orgId. Used by cross-branch scenarios.
 */
export async function addSecondaryBranch(env: ScenarioEnv, opts: {
  slug: string;
  name?: string;
  branchRole?: 'branch' | 'warehouse';
}): Promise<string> {
  const createRes = await env.server.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: env.auth.getHeaders('admin'),
    payload: { name: opts.name ?? opts.slug, slug: opts.slug },
  });
  const body = parse(createRes.body);
  const newOrgId = body?.id as string;
  if (!newOrgId) throw new Error(`Failed to create secondary branch: ${createRes.body}`);

  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(newOrgId) },
    {
      $set: {
        code: opts.slug.toUpperCase(),
        branchType: 'warehouse',
        branchRole: opts.branchRole ?? 'branch',
        isDefault: false,
        isActive: true,
      },
    },
  );

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch } = await import('./erp-seed.js');
  await setupBranch(getFlowEngine(), newOrgId);

  return newOrgId;
}
