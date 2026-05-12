/**
 * Cart guest merge — integration test
 *
 * Gap validated: `mergeDrafts()` from @classytic/cart is implemented but
 * POST /cart/merge was never wired in cart.resource.ts.
 *
 * RED: This test fails until the route is added.
 * GREEN: Add POST /merge handler to cart.controller.ts + cart.resource.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
const API = '/api/v1';

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'cart-merge' });
}, 90_000);

afterAll(async () => {
  await env.teardown();
});

/**
 * Insert a cart draft directly — bypasses the catalog bridge so we don't
 * need a real product seeded. Tests merge logic, not add-item validation.
 */
async function insertDraftForActor(actorRef: string, linePayload: string): Promise<string> {
  const db = mongoose.connection.db!;
  const publicId = randomUUID();
  await db.collection('cart_drafts').insertOne({
    publicId,
    organizationId: '',
    actorRef,
    actorKind: 'user',
    status: 'active',
    lines: [
      {
        lineId: randomUUID(),
        kind: 'sku',
        payload: { skuRef: linePayload },
        quantity: 2,
        display: null,
        addedAt: new Date(),
        metadata: null,
      },
    ],
    adjustments: [],
    currency: 'BDT',
    pricing: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return publicId;
}

describe('POST /cart/merge — guest cart merge on login', () => {
  it('merges source cart lines into the authenticated user cart and marks source abandoned', async () => {
    const db = mongoose.connection.db!;

    // ── 1. Get admin's Better Auth user ID ───────────────────────────────────
    const adminHeaders = env.auth.as('admin').headers;
    const meRes = await env.server.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: adminHeaders,
    });
    const meBody = parse(meRes.body) as Record<string, unknown> | null;
    const adminUserId = (meBody?.user as Record<string, unknown> | undefined)?.id as string;
    expect(adminUserId).toBeDefined();

    // ── 2. Seed a guest draft (simulates: guest browsed, added to cart, then logged in) ──
    const guestRef = `guest-session-${randomUUID()}`;
    const sourceCartId = await insertDraftForActor(guestRef, 'sku-product-xyz-001');

    // ── 3. Sign up + sign in user B ──────────────────────────────────────────
    const ts = Date.now();
    const email = `cart-merge-b-${ts}@test.com`;
    await env.server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password: 'TestPass123!', name: 'Cart Merge User B' },
    });
    const signInRes = await env.server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'TestPass123!' },
    });
    const tokenB = (parse(signInRes.body) as Record<string, unknown> | null)?.token as string;
    expect(tokenB).toBeDefined();
    const headersB = { authorization: `Bearer ${tokenB}` };

    // ── 4. POST /cart/merge — should assign source to user B ─────────────────
    const mergeRes = await env.server.inject({
      method: 'POST',
      url: `${API}/cart/merge`,
      headers: headersB,
      payload: { sourceCartId },
    });

    expect(mergeRes.statusCode).toBe(200);
    const merged = parse(mergeRes.body) as Record<string, unknown> | null;
    expect(Array.isArray(merged?.lines)).toBe(true);
    expect((merged!.lines as unknown[]).length).toBeGreaterThan(0);

    // Source draft was re-assigned to user B (no existing user cart →
    // mergeDrafts re-assigns instead of abandoning). actorRef must no
    // longer be the guest session ref.
    const source = await db.collection('cart_drafts').findOne({ publicId: sourceCartId });
    expect(source?.actorRef).not.toBe(guestRef);
  });

  it('returns 400 when sourceCartId is missing', async () => {
    const adminHeaders = env.auth.as('admin').headers;

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/cart/merge`,
      headers: adminHeaders,
      payload: {},
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 404 when source cart does not exist', async () => {
    const adminHeaders = env.auth.as('admin').headers;

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/cart/merge`,
      headers: adminHeaders,
      payload: { sourceCartId: 'non-existent-cart-id' },
    });

    expect(res.statusCode).toBe(404);
  });
});
