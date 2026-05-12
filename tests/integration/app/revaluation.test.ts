/**
 * Currency Revaluation endpoint — integration test (gap #12)
 *
 * Gap: No REST endpoint to run the month-end FX revaluation.
 * The @classytic/ledger package already has generateRevaluation() fully
 * implemented; be-prod just needs to wire a POST route.
 *
 * RED: fails with 404 until POST /accounting/reports/revaluation is added
 * GREEN: add handler + route to reports.handlers.ts / reports.resource.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
const API = '/api/v1';
const h = () => env.auth.as('admin').headers;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'fx-reval' });
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

describe('POST /accounting/reports/revaluation (gap #12)', () => {
  it('returns report with metadata, results and totalGainLoss for dry run', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/reports/revaluation`,
      headers: h(),
      payload: {
        asOfDate: '2026-05-01',
        rates: [{ currency: 'USD', rate: 120 }],
        generateEntry: false,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = parse(res.body) as Record<string, unknown>;
    expect(body).toHaveProperty('metadata');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('totalGainLoss');
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.asOfDate).toBe('2026-05-01');
    expect(meta.baseCurrency).toBe('BDT');
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.totalGainLoss).toBe(0); // no foreign accounts in test DB
  });

  it('returns 400 when asOfDate is missing', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/reports/revaluation`,
      headers: h(),
      payload: {
        rates: [{ currency: 'USD', rate: 120 }],
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('returns 400 when rates array is missing or empty', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/reports/revaluation`,
      headers: h(),
      payload: {
        asOfDate: '2026-05-01',
        rates: [],
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('returns 400 when generateEntry is true but unrealizedGainLossAccountId is missing', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/accounting/reports/revaluation`,
      headers: h(),
      payload: {
        asOfDate: '2026-05-01',
        rates: [{ currency: 'USD', rate: 120 }],
        generateEntry: true,
      },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
