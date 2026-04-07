/**
 * Notification E2E Integration Tests
 *
 * Full HTTP-level tests using Arc's setupBetterAuthOrg + createBetterAuthProvider.
 * Tests in-app notification CRUD, user scoping, branch scoping, and SSE endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ── Test Setup ──────────────────────────────────────────────────────────────

let ctx: TestOrgContext;
let auth: AuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function safeParseBody(body: string) {
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
  process.env.NOTIFICATION_CHANNELS = 'in_app,email';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../src/app.js');
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();

  const ts = Date.now();
  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources }),
    org: { name: `Notifications-${ts}`, slug: `notif-${ts}` },
    users: [
      { key: 'admin', email: `notif-admin-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({
    tokens: {
      admin: ctx.users.admin.token,
    },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });
}, 30_000);

afterAll(async () => {
  const db = mongoose.connection.db;
  if (db) {
    await db.collection('inappnotifications').deleteMany({});
  }
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createTestNotification(overrides: Record<string, unknown> = {}) {
  const db = mongoose.connection.db!;
  const doc = {
    organizationId: ctx.orgId,
    userId: ctx.users.admin.userId,
    type: 'order:created',
    title: 'Test Notification',
    message: 'This is a test notification',
    data: { link: '/dashboard/orders/123', entityId: '123', entityType: 'order' },
    read: false,
    readAt: null,
    priority: 'normal',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  const result = await db.collection('inappnotifications').insertOne(doc);
  return { ...doc, _id: result.insertedId.toString() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Notification E2E', () => {
  describe('GET /notifications', () => {
    it('should return empty list initially', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('should return notifications for current user', async () => {
      await createTestNotification();
      await createTestNotification({ title: 'Second' });

      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('should support pagination', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications?page=1&limit=1`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.data.length).toBe(1);
      expect(Number(body.pagination.limit)).toBe(1);
    });

    it('should filter unread only', async () => {
      await createTestNotification({ read: true, readAt: new Date() });

      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications?unreadOnly=true`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      for (const n of body.data) {
        expect(n.read).toBe(false);
      }
    });
  });

  describe('GET /notifications/unread-count', () => {
    it('should return unread count', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications/unread-count`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(typeof body.data.count).toBe('number');
      expect(body.data.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('should mark a notification as read', async () => {
      const notification = await createTestNotification();

      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/notifications/${notification._id}/read`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.read).toBe(true);
      expect(body.data.readAt).toBeTruthy();
    });

    it('should return 404 for non-existent notification', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/notifications/${fakeId}/read`,
        headers: auth.getHeaders('admin'),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /notifications/read-all', () => {
    it('should mark all notifications as read', async () => {
      await createTestNotification();
      await createTestNotification();

      const res = await server.inject({
        method: 'PATCH',
        url: `${API}/notifications/read-all`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(typeof body.data.modifiedCount).toBe('number');

      // Verify all are read
      const countRes = await server.inject({
        method: 'GET',
        url: `${API}/notifications/unread-count`,
        headers: auth.getHeaders('admin'),
      });
      const countBody = safeParseBody(countRes.body);
      expect(countBody.data.count).toBe(0);
    });
  });

  describe('Branch scoping', () => {
    it('should not see notifications from other branches', async () => {
      // Create notification for a different org
      await createTestNotification({ organizationId: 'other-org-id' });

      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      for (const n of body.data) {
        expect(n.organizationId).toBe(ctx.orgId);
      }
    });
  });

  describe('User scoping', () => {
    it('should not see notifications for other users', async () => {
      await createTestNotification({ userId: 'other-user-id' });

      const res = await server.inject({
        method: 'GET',
        url: `${API}/notifications`,
        headers: auth.getHeaders('admin'),
      });
      const body = safeParseBody(res.body);
      for (const n of body.data) {
        expect(n.userId).toBe(ctx.users.admin.userId);
      }
    });
  });

  describe('GET /notifications/stream (SSE)', () => {
    it('should have the SSE route registered (inject cannot test SSE streams)', async () => {
      // Fastify inject() waits for response end, but SSE never ends.
      // We verify the route exists by checking it doesn't 404.
      // Real SSE testing requires a TCP connection (manual curl test).
      const res = await server.inject({
        method: 'OPTIONS',
        url: `${API}/notifications/stream`,
        headers: auth.getHeaders('admin'),
      });
      // OPTIONS or any non-GET may return 404 if route doesn't exist, or 200/204
      expect(res.statusCode).not.toBe(404);
    });
  });
});
