/**
 * Notifications — scenario suite.
 *
 * Covers the user-scoped notification routes in
 * notification.resource.ts:
 *   GET    /notifications/
 *   GET    /notifications/unread-count
 *   PATCH  /notifications/:id/read
 *   PATCH  /notifications/read-all
 *
 * SSE (`GET /notifications/stream`) hijacks the reply and keeps the
 * connection open — not a good fit for fastify.inject. We assert the
 * route at least authenticates correctly and leave payload assertions
 * to a future live-server test.
 *
 * User isolation is the load-bearing contract: the repository filters
 * on `{ organizationId, userId }`. Test seeds notifications for a
 * second user and a second branch and asserts they never leak into
 * the admin's list.
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b) as Record<string, unknown>;
  } catch {
    return null;
  }
};

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: TestAuthProvider;
let adminUserId: string;
const h = (): Record<string, string> => auth.as('admin').headers;

async function seedNotification(opts: {
  userId: string;
  organizationId: string;
  type?: string;
  read?: boolean;
  createdAt?: Date;
}): Promise<string> {
  const NotificationModel = (await import('#resources/notifications/notification.model.js')).default;
  const doc = await NotificationModel.create({
    organizationId: opts.organizationId,
    userId: opts.userId,
    type: opts.type ?? 'order.placed',
    title: 'Test notification',
    message: 'Hello',
    read: opts.read ?? false,
    priority: 'normal',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  return String(doc._id);
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'notifications' });
  server = env.server;
  auth = env.auth;
  adminUserId = env.ctx.users.admin.userId;
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

beforeEach(async () => {
  const db = mongoose.connection.db!;
  await db.collection('inappnotifications').deleteMany({});
});

describe('Notifications — list + unread-count', () => {
  it('GET / returns only the caller\'s notifications in the active branch', async () => {
    await seedNotification({ userId: adminUserId, organizationId: env.orgId });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, type: 'shipment.updated' });
    // Foreign user in same branch — must not leak
    await seedNotification({ userId: new mongoose.Types.ObjectId().toString(), organizationId: env.orgId });
    // Same user, different branch — must not leak
    await seedNotification({ userId: adminUserId, organizationId: new mongoose.Types.ObjectId().toString() });

    const res = await server.inject({ method: 'GET', url: `${API}/notifications/`, headers: h() });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body) as { data: Array<{ userId: string; organizationId: string }>; pagination: unknown };
    const data = body.data;
    expect(data.length).toBe(2);
    for (const n of data) {
      expect(n.userId).toBe(adminUserId);
      expect(n.organizationId).toBe(env.orgId);
    }
  });

  it('GET /?unreadOnly=true filters out read notifications', async () => {
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: false });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: true });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/notifications/?unreadOnly=true`,
      headers: h(),
    });
    const body = parse(res.body) as { data: Array<{ read: boolean }> };
    const data = body.data;
    expect(data).toHaveLength(1);
    expect(data[0]!.read).toBe(false);
  });

  it('GET /?type=shipment.updated filters by type', async () => {
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, type: 'order.placed' });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, type: 'shipment.updated' });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/notifications/?type=shipment.updated`,
      headers: h(),
    });
    const body = parse(res.body) as { data: Array<{ type: string }> };
    const data = body.data;
    expect(data).toHaveLength(1);
    expect(data[0]!.type).toBe('shipment.updated');
  });

  it('GET /unread-count counts only unread for caller', async () => {
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: false });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: false });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: true });
    await seedNotification({ userId: new mongoose.Types.ObjectId().toString(), organizationId: env.orgId, read: false });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/notifications/unread-count`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { count: number };
    expect(data.count).toBe(2);
  });

  it('unauthenticated GET / → 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/notifications/` });
    expect(res.statusCode).toBe(401);
  });
});

describe('Notifications — mark read', () => {
  it('PATCH /:id/read marks one notification read, sets readAt', async () => {
    const id = await seedNotification({ userId: adminUserId, organizationId: env.orgId });

    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/notifications/${id}/read`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { read: boolean; readAt: string | null };
    expect(data.read).toBe(true);
    expect(data.readAt).toBeTruthy();
  });

  it('PATCH /:id/read returns 404 for a notification owned by another user', async () => {
    const foreignUser = new mongoose.Types.ObjectId().toString();
    const id = await seedNotification({ userId: foreignUser, organizationId: env.orgId });

    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/notifications/${id}/read`,
      headers: h(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /read-all marks every unread notification for caller, returns count', async () => {
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: false });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: false });
    await seedNotification({ userId: adminUserId, organizationId: env.orgId, read: true });
    // Foreign user — must not be touched
    await seedNotification({ userId: new mongoose.Types.ObjectId().toString(), organizationId: env.orgId, read: false });

    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/notifications/read-all`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { modifiedCount: number };
    expect(data.modifiedCount).toBe(2);

    const unreadRes = await server.inject({
      method: 'GET',
      url: `${API}/notifications/unread-count`,
      headers: h(),
    });
    const unreadCount = (parse(unreadRes.body) as { count: number }).count;
    expect(unreadCount).toBe(0);
  });
});

describe('Notifications — SSE guard', () => {
  it('GET /stream without a token → 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/notifications/stream` });
    expect(res.statusCode).toBe(401);
  });
});
