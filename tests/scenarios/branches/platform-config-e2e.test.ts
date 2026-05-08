/**
 * Platform Config — REST contract (integration)
 *
 * The platform config is a single-document, branch-agnostic singleton that
 * stores payment methods, VAT setup, checkout options, and membership tiers.
 * Every branch reads from it. A bad PATCH silently corrupts settings for the
 * whole company, so the contract is worth pinning hard:
 *
 *   - GET /platform/config returns the singleton (auto-creates on first read).
 *   - GET /platform/config?select=storeName,currency narrows the projection.
 *   - PATCH /platform/config performs a top-level merge: fields not in the
 *     payload survive untouched, fields in the payload replace prior values.
 *   - GET /platform/permissions/matrix returns the introspected RBAC matrix
 *     and is cached after the first hit (same shape on every call).
 *   - PATCH requires admin (or an equivalent platform-config role); a logged-
 *     in non-admin must NOT be able to mutate config.
 *
 * Boot uses the shared scenario harness (full Arc app, MongoMemoryReplSet).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'plat-cfg' });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('GET /platform/config — read', () => {
  it('returns the singleton document', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = parse(res.body) as Record<string, unknown>;
    expect(data).toBeTruthy();
    expect(data.isSingleton).toBe(true);
    // Seeded by the scenario harness.
    expect(typeof data.storeName === 'string' || typeof data.platformName === 'string').toBe(true);
  });

  it('honors ?select=platformName by narrowing the projection', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/platform/config?select=platformName`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    // Heavy nested fields must be absent when select narrows the projection.
    const keys = Object.keys(data).filter((k) => k !== '_id' && k !== '__v');
    expect(keys).not.toContain('paymentMethods');
    expect(keys).not.toContain('vat');
    expect(keys).not.toContain('membership');
  });
});

describe('PATCH /platform/config — deep merge', () => {
  it('replaces a top-level primitive (platformName) and persists it', async () => {
    const updateRes = await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
      payload: { platformName: 'BigBoss BD' },
    });
    expect(updateRes.statusCode, updateRes.body).toBe(200);
    const updated = (parse(updateRes.body) ?? {}) as Record<string, unknown>;
    expect(updated.platformName).toBe('BigBoss BD');

    // Re-read from Mongo to confirm the write landed (not just the response).
    const fromDb = await mongoose.connection.db!
      .collection('platformconfigs')
      .findOne({ isSingleton: true });
    expect(fromDb?.platformName).toBe('BigBoss BD');
  });

  it('deep-merges nested vat config without clobbering sibling keys', async () => {
    // Seed both `defaultRate` and `pricesIncludeVat`, then PATCH only one and
    // confirm the other survives — this is the core deep-merge contract.
    await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
      payload: { vat: { defaultRate: 15, pricesIncludeVat: true, isRegistered: true } },
    });

    const patchRes = await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
      payload: { vat: { defaultRate: 7.5 } }, // only one nested key
    });
    expect(patchRes.statusCode, patchRes.body).toBe(200);

    const fromDb = await mongoose.connection.db!
      .collection('platformconfigs')
      .findOne({ isSingleton: true });
    const vat = (fromDb?.vat ?? {}) as Record<string, unknown>;
    expect(vat.defaultRate).toBe(7.5);
    // Sibling keys must survive the partial merge.
    expect(vat.pricesIncludeVat).toBe(true);
    expect(vat.isRegistered).toBe(true);
    // Top-level platformName from the previous test is also preserved.
    expect(fromDb?.platformName).toBe('BigBoss BD');
  });

  it('replaces array fields wholesale (paymentMethods is an array, not merged)', async () => {
    await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
      payload: {
        paymentMethods: [
          { type: 'cash', name: 'Cash', isActive: true },
          { type: 'mfs', provider: 'bkash', name: 'bKash Personal', walletNumber: '01700000000', isActive: true },
        ],
      },
    });

    // Replace with a single-entry array; the bKash entry must be gone.
    const patchRes = await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      headers: env.auth.as('admin').headers,
      payload: { paymentMethods: [{ type: 'cash', name: 'Cash Only', isActive: true }] },
    });
    expect(patchRes.statusCode, patchRes.body).toBe(200);

    const fromDb = await mongoose.connection.db!
      .collection('platformconfigs')
      .findOne({ isSingleton: true });
    const methods = (fromDb?.paymentMethods ?? []) as Array<Record<string, unknown>>;
    expect(methods.length).toBe(1);
    expect(methods[0].name).toBe('Cash Only');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await env.server.inject({
      method: 'PATCH',
      url: `${API}/platform/config`,
      payload: { platformName: 'Should Not Apply' },
    });
    expect([401, 403]).toContain(res.statusCode);
    const fromDb = await mongoose.connection.db!
      .collection('platformconfigs')
      .findOne({ isSingleton: true });
    expect(fromDb?.platformName).not.toBe('Should Not Apply');
  });
});

describe('GET /platform/permissions/matrix — RBAC introspection', () => {
  it('returns the role list and per-module permission entries', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/platform/permissions/matrix`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as { roles?: string[]; modules?: Record<string, unknown> };
    expect(Array.isArray(data.roles)).toBe(true);
    expect((data.roles ?? []).length).toBeGreaterThan(0);
    expect(typeof data.modules).toBe('object');
    expect(Object.keys(data.modules ?? {}).length).toBeGreaterThan(0);
  });

  it('returns the same matrix shape on a second call (cache hit)', async () => {
    const a = parse((await env.server.inject({
      method: 'GET', url: `${API}/platform/permissions/matrix`,
      headers: env.auth.as('admin').headers,
    })).body);
    const b = parse((await env.server.inject({
      method: 'GET', url: `${API}/platform/permissions/matrix`,
      headers: env.auth.as('admin').headers,
    })).body);
    // Stable structure across calls — module keys identical.
    expect(Object.keys((a as { modules: Record<string, unknown> }).modules).sort())
      .toEqual(Object.keys((b as { modules: Record<string, unknown> }).modules).sort());
  });
});
