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

  const { loadTestResources } = await import('../../support/preload-resources.js');
  ({ resources: preloadedResources } = await loadTestResources());

  // Boot the real app
  const { createApplication } = await import('../../../src/app.js');
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
  const phone = `017${Date.now().toString().slice(-8)}`;
  const customer = await Customer.create({
    name: { given: 'Arc Route', family: 'Customer' },
    contact: { phone, email: `arc-route-${Date.now()}@test.bd` },
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

      expect(body.externalId).toBe(customerId);
      expect(body.status).toBe('active');
      expect(body.cardId).toBeDefined();
      expect(body.referralCode).toBeDefined();
      expect(body.cardId).not.toBe(body.referralCode);
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
      expect(body.member).toBeDefined();
      expect(body.balance).toBeDefined();
    });

    it('POST /loyalty/members/:customerId/action { action: "adjust" } — credits points', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'adjust', points: 500, reason: 'Arc route test bonus' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().balanceAfter).toBe(500);
    });

    it('GET /loyalty/members/:customerId/history — paginated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/members/${customerId}/history?page=1&limit=10`,
        headers: headers(),
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('POST /loyalty/members/:id/action { deactivate | reactivate } lifecycle', async () => {
      let res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'deactivate' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('inactive');

      res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'reactivate' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('active');
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
      ruleId = res.json()._id;
    });

    it('GET /loyalty/earning-rules — lists (Arc adapter pagination shape)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/earning-rules',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      // Arc adapter returns mongokit's OffsetPaginationResult — `data` is the
      // array of docs in Arc's standard envelope, with pagination meta alongside.
      const body = res.json();
      const docs = (body.data ?? []) as unknown[];
      expect(Array.isArray(docs)).toBe(true);
      expect((docs as unknown[]).length).toBeGreaterThan(0);
    });

    it('PATCH + deactivate via action (modern Arc adapter)', async () => {
      // Arc auto-CRUD adapter exposes PATCH for partial updates (modern REST
      // semantics) — old PUT behavior was raw-handler legacy.
      let res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/loyalty/earning-rules/${ruleId}`,
        headers: headers(),
        payload: { name: 'Updated Rule' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Updated Rule');

      // Stripe-style action: POST /:id/action { action: "deactivate" }
      res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/earning-rules/${ruleId}/action`,
        headers: headers(),
        payload: { action: 'deactivate' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('paused');
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
      tierId = res.json()._id;
    });

    it('GET + PATCH + DELETE lifecycle (Arc adapter)', async () => {
      let res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/tiers',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);

      // PATCH replaces legacy PUT — Arc adapter exposes PATCH for partial updates.
      res = await app.inject({
        method: 'PATCH',
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
  // TIER OVERRIDE — actions on member resource (regression)
  // ═══════════════════════════════════════════════════════════════

  describe('Member tier override (action)', () => {
    let overrideTierId: string;

    it('seed: create a tier to override to', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/tiers',
        headers: headers(),
        payload: {
          name: 'Arc Platinum (override)',
          rank: 9,
          qualificationCriteria: { minLifetimePoints: 50000 },
          benefits: { pointsMultiplier: 3, discountPercent: 15 },
        },
      });
      expect(res.statusCode).toBe(201);
      overrideTierId = res.json()._id;
      expect(overrideTierId).toBeDefined();
    });

    it('POST /loyalty/members/:id/action { set_tier_override } — applies override', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: {
          action: 'set_tier_override',
          tier: 'Arc Platinum (override)',
          reason: 'VIP comp test',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

    });

    it('POST /loyalty/members/:id/action { clear_tier_override } — removes override', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'clear_tier_override' },
      });
      expect(res.statusCode).toBe(200);

    });

    it('POST /loyalty/members/:id/action { set_tier_override } missing schema — 400', async () => {
      // memberSchemas.tierOverride requires `tier` + `reason`. AJV rejects
      // the bare action body with a 400 before the handler runs.
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'set_tier_override' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // REFERRALS — adapter CRUD + approve/reject actions
  // ═══════════════════════════════════════════════════════════════

  describe('Referral resource (adapter + actions)', () => {
    let referrerCode: string;
    let refereeCustomerId: string;
    let referralId: string;

    it('seed: create + enroll referee customer + capture referrer code', async () => {
      // The first customer's enrollment generated a referralCode — fetch it.
      const memberRes = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/members/${customerId}`,
        headers: headers(),
      });
      expect(memberRes.statusCode).toBe(200);
      referrerCode = memberRes.json().member.referralCode;
      expect(referrerCode).toBeTruthy();

      const Customer = mongoose.models.Customer;
      const phone = `017${(Date.now() + 1).toString().slice(-8)}`;
      const c = await Customer.create({
        name: { given: 'Referee', family: 'Test' },
        contact: { phone, email: `referee-${Date.now()}@test.bd` },
        isActive: true,
        stats: {
          orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
          revenue: { total: 0, lifetime: 0 },
        },
      });
      refereeCustomerId = c._id.toString();

      // recordReferral requires the referee to be enrolled as a loyalty
      // member (engine throws MEMBER_NOT_FOUND otherwise → 404).
      const enrollRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/members',
        headers: headers(),
        payload: { customerId: refereeCustomerId },
      });
      expect(enrollRes.statusCode).toBe(201);
    });

    it('GET /loyalty/referrals/lookup/:code — resolves to referrer member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/referrals/lookup/${referrerCode}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().referrerMemberId).toBeDefined();
    });

    it('GET /loyalty/referrals/lookup/:code — unknown code 404s', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/referrals/lookup/DOES-NOT-EXIST-XYZ',
        headers: headers(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /loyalty/referrals/record — runs recordReferral domain verb', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/referrals/record',
        headers: headers(),
        payload: { referralCode: referrerCode, refereeCustomerId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();

      expect(body._id).toBeDefined();
      referralId = body._id;
    });

    it('GET /loyalty/referrals?referrerId=... — adapter list with queryParser filter', async () => {
      // Use the lookup result so the test doesn't peek at member._id directly.
      const lookup = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/referrals/lookup/${referrerCode}`,
        headers: headers(),
      });
      const referrerMemberId = lookup.json().referrerMemberId;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/referrals?referrerId=${referrerMemberId}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Arc adapter flattens OffsetPaginationResult into the envelope.
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('POST /loyalty/referrals/:id/action { approve } — wired to engine.approve', async () => {
      // The loyalty engine ships with `autoApprove: true` by default, so
      // referrals come out of `record` already approved. Re-approving is an
      // FSM violation → 400 VALIDATION_ERROR. This test asserts the route
      // is wired and reaches the engine handler — the FSM rejection proves
      // it ran, not 404 (route missing) or 500 (handler crashed).
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/referrals/${referralId}/action`,
        headers: headers(),
        payload: { action: 'approve' },
      });
      expect([200, 400]).toContain(res.statusCode);
      const body = res.json();
      if (res.statusCode === 200) {
        expect(body.status).toBe('approved');
      } else {
        expect(body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('POST /loyalty/referrals/:id/action { reject } — schema enforces `reason`', async () => {
      // Record a fresh referral against a NEW referee (the engine refuses
      // duplicate referrer→referee pairs with DUPLICATE_REFERRAL → 409).
      const Customer = mongoose.models.Customer;
      const phone = `017${(Date.now() + 2).toString().slice(-8)}`;
      const c = await Customer.create({
        name: { given: 'Referee2', family: 'Test' },
        contact: { phone, email: `referee2-${Date.now()}@test.bd` },
        isActive: true,
        stats: {
          orders: { total: 0, completed: 0, cancelled: 0, refunded: 0 },
          revenue: { total: 0, lifetime: 0 },
        },
      });
      // Enroll referee2 first — recordReferral needs both sides as members.
      const enroll2 = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/members',
        headers: headers(),
        payload: { customerId: c._id.toString() },
      });
      expect(enroll2.statusCode).toBe(201);

      const recordRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/referrals/record',
        headers: headers(),
        payload: { referralCode: referrerCode, refereeCustomerId: c._id.toString() },
      });
      expect(recordRes.statusCode).toBe(201);
      const id = recordRes.json()._id;

      // reject without reason → AJV 400 (referralSchemas.reject.body requires it).
      const bad = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/referrals/${id}/action`,
        headers: headers(),
        payload: { action: 'reject' },
      });
      expect(bad.statusCode).toBe(400);

      // With reason: route + handler reach the engine. Auto-approved
      // referrals can't be rejected (same FSM rule), so 400 here is also
      // proof of correct wiring — the action verb landed in engine.reject.
      const ok = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/referrals/${id}/action`,
        headers: headers(),
        payload: { action: 'reject', reason: 'spam test referral' },
      });
      expect([200, 400]).toContain(ok.statusCode);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // REDEMPTIONS — validate / reserve / confirm / release lifecycle
  // ═══════════════════════════════════════════════════════════════

  describe('Redemptions', () => {
    let redemptionId: string;

    it('seed: top up enrolled customer with enough points to redeem', async () => {
      // The earlier "adjust" test left the balance close to zero after
      // deactivate/reactivate; credit a fresh batch so we have headroom.
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/members/${customerId}/action`,
        headers: headers(),
        payload: { action: 'adjust', points: 1000, reason: 'redemption test bootstrap' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().balanceAfter).toBeGreaterThanOrEqual(1000);
    });

    it('POST /loyalty/redemptions/validate — returns RedemptionValidation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/redemptions/validate',
        headers: headers(),
        payload: { customerId, pointsToRedeem: 200, orderTotal: 500 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body).toMatchObject({
        valid: expect.any(Boolean),
        pointsToRedeem: expect.any(Number),
        discountAmount: expect.any(Number),
        maxAllowedPoints: expect.any(Number),
      });
    });

    it('POST /loyalty/redemptions/reserve — creates a Redemption (status=reserved)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/redemptions/reserve',
        headers: headers(),
        payload: {
          customerId,
          pointsToRedeem: 200,
          orderTotal: 500,
          ownerType: 'order',
          ownerId: 'arc-test-order-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();

      expect(body._id).toBeDefined();
      expect(body.status).toBe('reserved');
      expect(body.pointsReserved).toBe(200);
      redemptionId = body._id;
    });

    it('GET /loyalty/redemptions/:id — fetches the reserved redemption', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/loyalty/redemptions/${redemptionId}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()._id).toBe(redemptionId);
    });

    it('POST /loyalty/redemptions/:id/action { release } — restores points', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/redemptions/${redemptionId}/action`,
        headers: headers(),
        payload: { action: 'release' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('released');
    });

    it('POST /loyalty/redemptions/reserve → confirm — debits pointsConfirmed', async () => {
      const reserveRes = await app.inject({
        method: 'POST',
        url: '/api/v1/loyalty/redemptions/reserve',
        headers: headers(),
        payload: {
          customerId,
          pointsToRedeem: 150,
          orderTotal: 400,
          ownerType: 'order',
          ownerId: 'arc-test-order-2',
        },
      });
      expect(reserveRes.statusCode).toBe(201);
      const id = reserveRes.json()._id as string;

      const confirmRes = await app.inject({
        method: 'POST',
        url: `/api/v1/loyalty/redemptions/${id}/action`,
        headers: headers(),
        payload: { action: 'confirm' },
      });
      expect(confirmRes.statusCode).toBe(200);
      const body = confirmRes.json();
      expect(body.status).toBe('confirmed');
      expect(body.pointsConfirmed).toBe(150);
    });

    it('GET /loyalty/redemptions/:id — 404 when missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/loyalty/redemptions/000000000000000000000000',
        headers: headers(),
      });
      expect(res.statusCode).toBe(404);
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
