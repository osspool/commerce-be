/**
 * Rate limit — scenario suite.
 *
 * The app wires `@fastify/rate-limit` in createArcAppOptions with
 * `max: config.rateLimit.max` and `createTenantKeyGenerator()`. We
 * override both via env at scenario boot to:
 *
 *   - drive the ceiling down to a testable number (RATE_LIMIT_MAX=5)
 *   - shrink the window so the test isn't flaky on slow runners
 *     (RATE_LIMIT_WINDOW_MS=60_000)
 *
 * Financial endpoints are the ones the security memo calls out; we
 * hit `/webhooks/payments/:provider` (public, no auth filtering) and
 * `/analytics/dashboard` (auth + tenant-scoped) and assert the limit
 * trips and surfaces 429 with the standard fastify-rate-limit body.
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';
const WEBHOOK_PREFIX = '/webhooks/payments';
const MAX = 5;

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: TestAuthProvider;
const h = (): Record<string, string> => auth.as('admin').headers;

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'security-rate-limit',
    env: {
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: String(MAX),
      RATE_LIMIT_WINDOW_MS: '60000',
    },
  });
  server = env.server;
  auth = env.auth;
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

async function hammer(
  inject: () => Promise<{ statusCode: number; headers: Record<string, unknown> }>,
  count: number,
): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await inject();
    codes.push(res.statusCode);
  }
  return codes;
}

describe('Rate limit — public payment webhook', () => {
  it('trips 429 after MAX requests within the window', async () => {
    // Unregistered provider = 404, which is still rate-limited. Using an
    // unknown provider keeps us off the webhook decode path (no carrier
    // HTTP, no log noise) while still walking through the Fastify hook
    // chain that applies the rate limit.
    const codes = await hammer(
      () =>
        server.inject({
          method: 'POST',
          url: `${WEBHOOK_PREFIX}/provider-does-not-exist`,
          payload: { type: 'x' },
        }),
      MAX + 3,
    );

    const allowed = codes.filter((c) => c !== 429).length;
    const blocked = codes.filter((c) => c === 429).length;

    expect(allowed).toBeLessThanOrEqual(MAX);
    expect(blocked).toBeGreaterThanOrEqual(1);
  });

  it('429 response includes Retry-After header', async () => {
    let last: { statusCode: number; headers: Record<string, unknown> } | null = null;
    for (let i = 0; i < MAX + 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      last = await server.inject({
        method: 'POST',
        url: `${WEBHOOK_PREFIX}/provider-does-not-exist`,
        payload: { type: 'x' },
      });
      if (last.statusCode === 429) break;
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.headers['retry-after']).toBeDefined();
  });
});

describe('Rate limit — authenticated admin endpoint', () => {
  it('trips 429 on /analytics/dashboard once the tenant-scoped budget is spent', async () => {
    const codes = await hammer(
      () =>
        server.inject({
          method: 'GET',
          url: `${API}/analytics/dashboard?period=7d`,
          headers: h(),
        }),
      MAX + 3,
    );

    const blocked = codes.filter((c) => c === 429).length;
    expect(blocked).toBeGreaterThanOrEqual(1);
  });
});
