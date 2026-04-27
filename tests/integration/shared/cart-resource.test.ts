/**
 * Cart resource integration test — boots a minimal Fastify app with
 * the cart resource, hits endpoints via `app.inject()`.
 *
 * Uses the per-suite MongoMemoryServer from the setup file — don't
 * call mongoose.connect() here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { eventRegistry } from '../../../src/shared/event-registry.js';
import { initCartEngine } from '../../../src/resources/sales/cart/cart.engine.js';
import cartResource from '../../../src/resources/sales/cart/cart.resource.js';

let app: FastifyInstance;

// Cart stores organizationId as ObjectId (matches Better Auth) — use a valid 24-char hex.
const TEST_USER = { _id: 'user_cart_test', id: 'user_cart_test' };
const TEST_ORG = new Types.ObjectId().toHexString();

beforeAll(async () => {
  await initCartEngine();

  app = Fastify({ logger: false });

  // Mock auth
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: typeof TEST_USER }).user = TEST_USER;
  });

  await app.register(
    async (scoped) => {
      await scoped.register(cartResource.toPlugin());
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
}, 10_000);

function h() {
  return { 'content-type': 'application/json', 'x-organization-id': TEST_ORG };
}

describe('Cart routes are registered', () => {
  it('registers package-backed cart events in the shared Arc registry', () => {
    expect(eventRegistry.get('cart.draft.created', 1)).toBeDefined();
    expect(eventRegistry.get('cart.checkout.committed', 1)).toBeDefined();
  });

  it('GET /cart returns 200 with null data (empty cart)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/cart', headers: h() });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().data).toBeNull();
  });

  it('DELETE /cart returns non-200 when no cart exists', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/cart', headers: h() });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('POST /cart/checkout returns 404 when no cart exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/checkout',
      headers: h(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Cart schema validation (arc auto-converts zod)', () => {
  it('POST /cart/items rejects missing productId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: h(),
      payload: { quantity: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /cart/items rejects quantity 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: h(),
      payload: { productId: 'x', quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /cart/items rejects negative quantity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: h(),
      payload: { productId: 'x', quantity: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /cart/items/:id rejects missing quantity', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cart/items/fake-line-id',
      headers: h(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('All 11 cart routes reachable (not 404 for route, though handler may 4xx)', () => {
  // Reachability check — routes are registered and respond (may return 4xx
  // from handler logic like "product not found" or "cart not found", but NOT
  // route-level 404 which would mean the route is missing.
  //
  // Behavioral tests live in cart-behavior.test.ts.
  const routes = [
    { method: 'GET' as const, url: '/api/v1/cart' },
    { method: 'PATCH' as const, url: '/api/v1/cart/items/fake', payload: { quantity: 1 } },
    { method: 'DELETE' as const, url: '/api/v1/cart/items/fake' },
    { method: 'DELETE' as const, url: '/api/v1/cart' },
    { method: 'POST' as const, url: '/api/v1/cart/checkout', payload: {} },
    { method: 'POST' as const, url: '/api/v1/cart/checkout/fake/commit', payload: {} },
    { method: 'POST' as const, url: '/api/v1/cart/checkout/fake/cancel', payload: {} },
    { method: 'GET' as const, url: '/api/v1/cart/admin/all' },
    { method: 'GET' as const, url: '/api/v1/cart/admin/abandoned' },
    { method: 'GET' as const, url: '/api/v1/cart/admin/user/fake-uid' },
  ];

  for (const route of routes) {
    it(`${route.method} ${route.url} is reachable`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: h(),
        ...(route.payload ? { payload: route.payload } : {}),
      });
      // Route exists — handler executed (even if it returned 4xx/5xx).
      // Fastify's own 404 body has `error: 'Not Found'` — anything else means
      // the route matched and ran.
      const body = JSON.parse(res.body || '{}');
      expect(body.error).not.toBe('Not Found');
    });
  }
});
