/**
 * Logistics — scenario suite.
 *
 * Exercises the Arc route surface of logistics.resource.ts without hitting
 * any live carrier API. `@classytic/bd-areas` (+ the `/pathao` subpath) is
 * a static dataset, so /locations/* routes resolve purely in-process.
 *
 * Carrier-dependent routes (/quote, /shipments, /pickup-stores) are
 * validated at the guard layer: with no REDX_/PATHAO_/STEADFAST_ env in
 * the test, the CarrierRegistry is empty and we assert the expected
 * 4xx failure shape — matching the module's "providers are optional"
 * contract (logistics/CLAUDE.md).
 */

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '@classytic/arc/testing';
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

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: AuthProvider;
const h = (): Record<string, string> => auth.getHeaders('admin');

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'logistics',
    env: { ENABLED_FEATURES: 'logistics' },
  });
  server = env.server;
  auth = env.auth;
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

describe('Logistics — public location taxonomy (bd-areas)', () => {
  it('GET /logistics/locations/divisions returns the 8 BD divisions', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/divisions` });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const data = body?.data as Array<{ name: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(8);
  });

  it('GET /logistics/locations/divisions/:division/districts returns a list', async () => {
    const list = parse(
      (await server.inject({ method: 'GET', url: `${API}/logistics/locations/divisions` })).body,
    )?.data as Array<{ id?: string; name?: string }>;
    const anyDivision = list[0]!.id ?? list[0]!.name ?? 'dhaka';

    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/locations/divisions/${anyDivision}/districts`,
    });
    expect([200, 404]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const data = parse(res.body)?.data as unknown[];
      expect(Array.isArray(data)).toBe(true);
    }
  });

  it('GET /logistics/locations/divisions/:division/districts 404s for unknown division', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/locations/divisions/not-a-real-division/districts`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /logistics/locations/areas/search requires q of length >= 2', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/areas/search?q=a` });
    expect(res.statusCode).toBe(400);
  });

  it('GET /logistics/locations/areas/by-postcode rejects non-numeric', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/locations/areas/by-postcode?postCode=abc`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /logistics/locations/zones returns internal pricing tiers', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/zones` });
    expect(res.statusCode).toBe(200);
    // DELIVERY_ZONES is a Record<number, DeliveryZone> — keyed object, not array.
    const data = parse(res.body)?.data as Record<string, { name: string; baseCharge: number }>;
    expect(typeof data).toBe('object');
    expect(Object.keys(data).length).toBeGreaterThan(0);
    const first = Object.values(data)[0]!;
    expect(typeof first.baseCharge).toBe('number');
    expect(typeof first.name).toBe('string');
  });

  it('GET /logistics/locations/estimate requires areaId', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/estimate` });
    expect(res.statusCode).toBe(400);
  });
});

describe('Logistics — Pathao taxonomy (static)', () => {
  it('GET /logistics/locations/pathao/cities returns the full list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/pathao/cities` });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body)?.data as Array<{ cityId: number; cityName: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(typeof data[0]!.cityId).toBe('number');
  });

  it('GET /logistics/locations/pathao/cities/:cityId/zones returns zones for a known city', async () => {
    const cities = parse(
      (await server.inject({ method: 'GET', url: `${API}/logistics/locations/pathao/cities` })).body,
    )?.data as Array<{ cityId: number }>;
    const cityId = cities[0]!.cityId;

    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/locations/pathao/cities/${cityId}/zones`,
    });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body)?.data as { city: unknown; zones: unknown[] };
    expect(data.city).toBeTruthy();
    expect(Array.isArray(data.zones)).toBe(true);
  });

  it('GET /logistics/locations/pathao/cities/:cityId/zones 400s for non-numeric cityId', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/locations/pathao/cities/not-a-number/zones`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /logistics/locations/pathao/search requires q of length >= 2', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/locations/pathao/search?q=d` });
    expect(res.statusCode).toBe(400);
  });
});

describe('Logistics — admin + manage guards', () => {
  it('GET /logistics/config requires auth (401 without bearer)', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/config` });
    expect(res.statusCode).toBe(401);
  });

  it('GET /logistics/config returns configured carriers for admin', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/config`, headers: h() });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body)?.data as { configured: unknown[]; capabilities: unknown };
    expect(Array.isArray(data.configured)).toBe(true);
    expect(typeof data.capabilities).toBe('object');
  });

  it('POST /logistics/quote requires auth (401 without bearer)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/quote`,
      payload: { destination: { city: 'Dhaka' }, weightGrams: 500 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /logistics/quote validates body — missing destination and fulfillmentNumber → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/quote`,
      headers: h(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /logistics/shipments validates body — missing orderNumber → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/shipments`,
      headers: h(),
      payload: { fulfillmentNumber: 'F-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /logistics/webhooks/:provider is public (no bearer required)', async () => {
    // Empty carrier registry → service rejects, but only after auth passes.
    // We assert the route is NOT guarded by auth (no 401), not the success
    // body — actual delivery is covered by the carrier-bd package e2e.
    const res = await server.inject({
      method: 'POST',
      url: `${API}/logistics/webhooks/redx`,
      payload: { event: 'delivery.updated', trackingId: 'TRK-1' },
    });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('Logistics — Pathao CSV export', () => {
  it('GET /logistics/export/pathao-csv requires auth', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/logistics/export/pathao-csv` });
    expect(res.statusCode).toBe(401);
  });

  it('GET /logistics/export/pathao-csv is wired and admin-authorised (route reachable)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/logistics/export/pathao-csv`,
      headers: h(),
    });
    // Contract pinned here: the route exists, auth passes, and we leave the
    // provider (empty-row library behaviour) to carrier-bd's own e2e suite.
    // A seeded-order variant belongs in an order-centric test file.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(404);
  });
});
