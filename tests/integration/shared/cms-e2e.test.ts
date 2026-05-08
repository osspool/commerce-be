/**
 * CMS E2E Integration Tests
 *
 * Full HTTP-level tests for slug-based CMS pages.
 * Tests public read, admin CRUD, upsert, and 404 handling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ── Test Setup ──────────────────────────────────────────────────────────────

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function parseBody(body: string) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test Commerce',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();

  const ts = Date.now();
    const __testApp = await createApplication({ resources });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `CMS-Test-${ts}`, slug: `cms-test-${ts}` },
    users: [
      { key: 'admin', email: `cms-admin-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;

  // Set user-level role to 'admin' (setupBetterAuthOrg only sets org member role)
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.users.admin.userId) },
    { $set: { role: 'admin' } },
  );

  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });
}, 90_000);

afterAll(async () => {
  const db = mongoose.connection.db;
  if (db) {
    await db.collection('cms').deleteMany({});
  }
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CMS E2E', () => {
  // ── Public GET ────────────────────────────────────────────────────────────

  describe('GET /cms/:slug (public)', () => {
    it('should return 404 for non-existent page', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/cms/non-existent-page`,
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(404);
    });

    it('should return page by slug without auth', async () => {
      // Seed a page directly
      const db = mongoose.connection.db!;
      await db.collection('cms').insertOne({
        name: 'Home Page',
        slug: 'home',
        status: 'published',
        content: { hero: { headline: 'Welcome' } },
        metadata: { title: 'Home' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await server.inject({
        method: 'GET',
        url: `${API}/cms/home`,
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.slug).toBe('home');
      expect(body.content.hero.headline).toBe('Welcome');
    });
  });

  // ── Admin POST (getOrCreate) ──────────────────────────────────────────────

  describe('POST /cms/:slug (admin getOrCreate)', () => {
    it('should create page if it does not exist', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/cms/about-us`,
        headers: auth.as('admin').headers,
        payload: {
          content: { intro: 'About our company' },
          status: 'draft',
        },
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.slug).toBe('about-us');
      expect(body.name).toBe('about-us'); // defaults name to slug
      expect(body.content.intro).toBe('About our company');
    });

    it('should return existing page on second call', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/cms/about-us`,
        headers: auth.as('admin').headers,
        payload: {
          content: { intro: 'Different content' },
        },
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.slug).toBe('about-us');
      // Should return existing, not create new
      expect(body.content.intro).toBe('About our company');
    });

    it('should reject unauthenticated request', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/cms/private-page`,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
    });
  });

  // ── Admin PATCH (upsert) ──────────────────────────────────────────────────

  describe('PATCH /cms/:slug (admin update)', () => {
    it('should upsert a new page', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/cms/shipping-delivery`,
        headers: auth.as('admin').headers,
        payload: {
          content: { zones: ['Dhaka', 'Chittagong'] },
          status: 'published',
        },
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.slug).toBe('shipping-delivery');
      expect(body.status).toBe('published');
    });

    it('should update existing page content', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/cms/shipping-delivery`,
        headers: auth.as('admin').headers,
        payload: {
          content: { zones: ['Dhaka', 'Chittagong', 'Sylhet'] },
        },
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.content.zones).toHaveLength(3);
    });

    it('should not allow slug override via payload', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/cms/shipping-delivery`,
        headers: auth.as('admin').headers,
        payload: {
          slug: 'hacked-slug',
          content: { zones: ['Dhaka'] },
        },
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.slug).toBe('shipping-delivery');
    });

    it('should reject unauthenticated request', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/cms/shipping-delivery`,
        payload: { content: {} },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
    });
  });

  // ── Admin DELETE ──────────────────────────────────────────────────────────

  describe('DELETE /cms/:slug (admin)', () => {
    it('should delete existing page', async () => {
      // Create a page to delete
      await server.inject({
        method: 'PATCH',
        url: `${API}/cms/temp-page`,
        headers: auth.as('admin').headers,
        payload: { content: { text: 'temporary' } },
      });

      const res = await server.inject({
        method: 'DELETE',
        url: `${API}/cms/temp-page`,
        headers: auth.as('admin').headers,
      });
      const body = parseBody(res.body);
      expect(res.statusCode).toBe(200);

      // Confirm it's gone
      const getRes = await server.inject({
        method: 'GET',
        url: `${API}/cms/temp-page`,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('should return 404 for non-existent page', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `${API}/cms/does-not-exist`,
        headers: auth.as('admin').headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject unauthenticated request', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: `${API}/cms/home`,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
    });
  });

  // ── Public access control ─────────────────────────────────────────────────

  describe('Access control', () => {
    it('GET should work without auth (public endpoint)', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/cms/home`,
      });
      // Either 200 (exists) or 404 (not found) — both valid, neither 401/403
      expect([200, 404]).toContain(res.statusCode);
    });

    it('POST/PATCH/DELETE should require auth', async () => {
      const methods = ['POST', 'PATCH', 'DELETE'] as const;
      for (const method of methods) {
        const res = await server.inject({
          method,
          url: `${API}/cms/test-auth`,
          ...(method !== 'DELETE' ? { payload: { content: {} } } : {}),
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(401);
      }
    });
  });
});
