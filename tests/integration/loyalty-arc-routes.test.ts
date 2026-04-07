/**
 * Loyalty Arc Routes E2E — HTTP-level tests through Fastify inject
 *
 * Tests the /loyalty/* endpoints through the full Arc stack:
 * - Auth (Better Auth bearer tokens)
 * - Permissions (loyalty.manage / loyalty.view)
 * - Arc resource routing (defineResource + additionalRoutes)
 * - Zod schema validation
 * - Engine service execution
 *
 * Uses the actual app boot path — same as production.
 */

// Env vars BEFORE imports
process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;
let adminToken: string;
let customerId: string;
let preloadedResources: any;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();
  process.env.MONGO_URI = uri;
  await mongoose.connect(uri);

  // Reset auth singleton
  const { resetAuth } = await import('#resources/auth/auth.config.js');
  resetAuth();

  const { loadTestResources } = await import('../setup/preload-resources.js');
  ({ resources: preloadedResources } = await loadTestResources());

  // Boot the real app
  const { createApplication } = await import('../../src/app.js');
  app = await createApplication({ resources: preloadedResources });
  await app.ready();

  // Create admin user via Better Auth
  const signupRes = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: 'loyalty-admin@test.com', password: 'password123456', name: 'Loyalty Admin' },
  });
  const signupBody = JSON.parse(signupRes.body);
  adminToken = signupBody?.token || '';

  // Grant admin role
  const db = mongoose.connection.getClient().db();
  if (signupBody?.user?.id) {
    await db.collection('user').updateOne(
      { _id: new mongoose.Types.ObjectId(signupBody.user.id) },
      { $set: { role: ['admin', 'superadmin'] } },
    );
  }

  // Re-login to get token with updated roles
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: 'loyalty-admin@test.com', password: 'password123456' },
  });
  adminToken = JSON.parse(loginRes.body)?.token || adminToken;

  // Seed PlatformConfig with membership enabled
  const PlatformConfig = mongoose.models.PlatformConfig;
  if (PlatformConfig) {
    await PlatformConfig.findOneAndUpdate(
      { isSingleton: true },
      {
        $set: {
          isSingleton: true,
          membership: {
            enabled: true,
            pointsPerAmount: 1,
            amountPerPoint: 100,
            roundingMode: 'floor',
            tiers: [
              { name: 'Bronze', minPoints: 0, pointsMultiplier: 1, discountPercent: 0 },
              { name: 'Silver', minPoints: 100, pointsMultiplier: 1.5, discountPercent: 5 },
            ],
            cardPrefix: 'ARC',
            cardDigits: 8,
            redemption: { enabled: true, pointsPerBdt: 10, minRedeemPoints: 50, maxRedeemPercent: 50 },
          },
        },
      },
      { upsert: true },
    );
  }

  // Create a test customer
  const Customer = mongoose.models.Customer;
  const customer = await Customer.create({
    name: 'Arc Route Customer',
    phone: `017${Date.now().toString().slice(-8)}`,
    email: `arc-route-${Date.now()}@test.bd`,
    isActive: true,
    stats: {
      orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
      revenue: { total: 0, lifetime: 0 },
    },
  });
  customerId = customer._id.toString();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await mongoose.disconnect();
  await replSet?.stop();
}, 30_000);

function headers() {
  return { authorization: `Bearer ${adminToken}` };
}

// ═══════════════════════════════════════════════════════════════════
// MEMBER ROUTES
// ═══════════════════════════════════════════════════════════════════

describe('Loyalty Arc Routes', () => {
  describe('Members', () => {
    it('POST /loyalty/members — enrolls and returns smart card ID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/members',
        headers: headers(),
        payload: { customerId },
      });

      const body = res.json();
      expect(res.statusCode).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.externalId).toBe(customerId);
      expect(body.data.status).toBe('active');
      expect(body.data.cardId).toBeDefined();
      expect(body.data.referralCode).toBeDefined();
      expect(body.data.cardId).not.toBe(body.data.referralCode);
    });

    it('POST /loyalty/members — duplicate returns 409', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/members',
        headers: headers(),
        payload: { customerId },
      });
      expect(res.statusCode).toBe(409);
    });

    it('GET /loyalty/members/:customerId — returns member + balance', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/members/${customerId}`,
        headers: headers(),
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.data.member).toBeDefined();
      expect(body.data.balance).toBeDefined();
    });

    it('POST /loyalty/members/:customerId/adjust — credits points', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/adjust`,
        headers: headers(),
        payload: { points: 500, reason: 'Arc route test bonus' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.balanceAfter).toBe(500);
    });

    it('GET /loyalty/members/:customerId/history — paginated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/members/${customerId}/history?page=1&limit=10`,
        headers: headers(),
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.data.docs.length).toBeGreaterThan(0);
    });

    it('POST /loyalty/members/:id/deactivate + reactivate lifecycle', async () => {
      let res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/deactivate`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('inactive');

      res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/reactivate`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('active');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // EARNING RULES
  // ═══════════════════════════════════════════════════════════════

  let ruleId: string;

  describe('Earning Rules', () => {
    it('POST /loyalty/earning-rules — creates', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/earning-rules',
        headers: headers(),
        payload: {
          name: 'Arc Test Rule',
          type: 'order',
          priority: 10,
          reward: { multiplier: 2 },
        },
      });

      expect(res.statusCode).toBe(201);
      ruleId = res.json().data._id;
    });

    it('GET /loyalty/earning-rules — lists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/earning-rules',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.docs.length).toBeGreaterThan(0);
    });

    it('PUT + deactivate lifecycle', async () => {
      let res = await app.inject({
        method: 'PUT',
        url: `/api/v1/loyalty/earning-rules/${ruleId}`,
        headers: headers(),
        payload: { name: 'Updated Rule' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.name).toBe('Updated Rule');

      res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/earning-rules/${ruleId}/deactivate`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('paused');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TIERS
  // ═══════════════════════════════════════════════════════════════

  let tierId: string;

  describe('Tiers', () => {
    it('POST /loyalty/tiers — creates', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/tiers',
        headers: headers(),
        payload: {
          name: 'Arc Gold',
          rank: 3,
          qualificationCriteria: { minLifetimePoints: 5000 },
          benefits: { pointsMultiplier: 2, discountPercent: 10 },
        },
      });
      expect(res.statusCode).toBe(201);
      tierId = res.json().data._id;
    });

    it('GET + PUT + DELETE lifecycle', async () => {
      let res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/tiers',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);

      res = await app.inject({
        method: 'PUT',
        url: `/api/v1/loyalty/tiers/${tierId}`,
        headers: headers(),
        payload: { color: '#FFD700' },
      });
      expect(res.statusCode).toBe(200);

      res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/loyalty/tiers/${tierId}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LEGACY REMOVED
  // ═══════════════════════════════════════════════════════════════

  describe('Legacy endpoints removed', () => {
    it('POST /customers/:id/membership — 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/customers/${customerId}/membership`,
        headers: headers(),
        payload: { action: 'enroll' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
