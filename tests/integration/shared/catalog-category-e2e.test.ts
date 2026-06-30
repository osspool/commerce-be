/**
 * Catalog Category E2E — HTTP-level tests via app.inject().
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestOrg, teardownTestOrg, authHeaders, createOrg } from '../../support/test-org-setup.js';

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;

const API = '/api/v1/categories';
let parentId: string;
let childId: string;

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 90_000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

describe('Category CRUD', () => {
  it('POST / — creates a root category', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Men',
        slug: 'men',
        description: 'Menswear',
        displayOrder: 0,
        isActive: true,
      },
    });

    if (res.statusCode >= 400) {
      console.error('CREATE CATEGORY ERROR:', res.statusCode, res.body);
    }
    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.slug).toBe('men');
    parentId = body._id;
  });

  it('POST / — creates a child category', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Shirts',
        slug: 'shirts',
        parent: 'men',
        description: 'Men shirts',
        displayOrder: 1,
        isActive: true,
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    childId = body._id;
  });

  it('GET / — lists categories', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const docs = body.data ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /:id — gets category by ID', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${parentId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Men');
  });
});

describe('Category Custom Routes', () => {
  it('GET /slug/:slug — finds by slug', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/slug/men`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Men');
  });

  it('GET /tree — builds a nested 2-level tree from ONE query (+ caches)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/tree`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ slug: string; parent?: string | null; children?: Array<{ parent?: string }> }>;
    expect(Array.isArray(body)).toBe(true);

    // 'men' (root) was created with a child (parent: 'men'). The single-query
    // in-memory tree build must nest that child under `children` — this is the
    // regression guard for the old N+1 handler.
    const men = body.find((c) => c.slug === 'men');
    expect(men, "'men' root present in tree").toBeDefined();
    expect(Array.isArray(men!.children)).toBe(true);
    expect(men!.children!.length).toBeGreaterThan(0);
    for (const child of men!.children!) {
      expect(child.parent).toBe('men');
    }
    // Roots only at the top level (no child leaked to the root array).
    expect(body.every((c) => c.parent == null)).toBe(true);

    // Cache consistency — a second read returns the identical tree.
    const res2 = await ctx.app.inject({
      method: 'GET',
      url: `${API}/tree`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body)).toEqual(body);
  });

  it('GET /:parentSlug/children — returns children', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/men/children`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('a category mutation busts the /tree cache (no 60s staleness)', async () => {
    // Prime the cache.
    await ctx.app.inject({ method: 'GET', url: `${API}/tree`, headers: authHeaders(ctx.users.admin.token, ctx.orgId) });

    // Create a new root AFTER the tree was cached.
    const created = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { name: 'Gadgets', slug: 'gadgets', description: 'Tech', displayOrder: 9, isActive: true },
    });
    expect(created.statusCode).toBeLessThan(300);

    // The tree must reflect it immediately — the mutation invalidated the cache.
    const res = await ctx.app.inject({ method: 'GET', url: `${API}/tree`, headers: authHeaders(ctx.users.admin.token, ctx.orgId) });
    const tree = JSON.parse(res.body) as Array<{ slug: string }>;
    expect(tree.some((c) => c.slug === 'gadgets'), 'new category appears in tree without waiting for TTL').toBe(true);

    // Cleanup so it doesn't leak into the company-wide regression block below.
    await ctx.app.inject({ method: 'DELETE', url: `${API}/${JSON.parse(created.body)._id}`, headers: authHeaders(ctx.users.admin.token, ctx.orgId) });
  });
});

describe('Category Delete', () => {
  it('DELETE /:id — deletes child category', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${API}/${childId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
  });

  it('DELETE /:id — deletes parent category', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${API}/${parentId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── Company-wide access (regression) ─────────────────────────────────────
//
// BigBoss is single-tenant / multi-branch (see AGENTS.md — "Products are
// company-wide. Shared catalog, per-branch stock enrichment."). The catalog
// engine runs in `mode: 'global'`, so category documents carry no
// `organizationId` field. Arc's default tenant guard would inject
// `{ organizationId: <header> }` into every query and reject with
// ORG_SCOPE_DENIED / 404.
//
// `category.resource.ts` opts out via `tenantField: false`. These tests
// pin that behavior: a category created while Branch A is active MUST
// remain readable / updatable / deletable when a request comes in under
// Branch B's `x-organization-id`. Removing `tenantField: false` will
// flip these back to 404.

describe('Category Company-Wide Access (tenantField:false regression)', () => {
  let branchBId: string;
  let sharedCategoryId: string;

  beforeAll(async () => {
    // Second branch for the same admin — proves cross-branch visibility.
    const branchB = await createOrg(ctx.app, ctx.users.admin.token, {
      name: 'Test Branch B',
      slug: 'test-branch-b',
    });
    expect(branchB.statusCode).toBe(200);
    branchBId = branchB.orgId;
    expect(branchBId).toBeTruthy();
    expect(branchBId).not.toBe(ctx.orgId);
  });

  it('creates a category in Branch A', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Shared Catalog Category',
        slug: 'shared-catalog-category',
        description: 'Created in A, touched from B',
        displayOrder: 0,
        isActive: true,
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    sharedCategoryId = body._id;
  });

  it('GET /:id from Branch B succeeds (catalog is company-wide)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${sharedCategoryId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    // A 404 here almost certainly means `tenantField: false` was removed
    // from category.resource.ts — Arc re-injected the scope filter and
    // the org-less catalog doc stopped matching. See AGENTS.md.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body._id).toBe(sharedCategoryId);
    expect(body.name).toBe('Shared Catalog Category');
  });

  it('PATCH /:id from Branch B succeeds', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${sharedCategoryId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
      payload: { description: 'Updated from Branch B' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.description).toBe('Updated from Branch B');
  });

  it('GET / from Branch B lists the Branch-A-created category', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: API,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const docs = (body.data ?? body.data) as Array<{ _id: string }>;
    expect(docs.some((d) => d._id === sharedCategoryId)).toBe(true);
  });

  it('DELETE /:id from Branch B succeeds', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${API}/${sharedCategoryId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    expect(res.statusCode).toBe(200);
  });
});
