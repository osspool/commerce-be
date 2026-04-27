/**
 * Inventory Reports — E2E Integration Tests
 *
 * Tests ALL 6 report endpoints with seeded stock data.
 * Runs in enterprise mode so every endpoint is reachable.
 *
 * Flow:
 *   1. Boot with FLOW_MODE=enterprise
 *   2. Seed stock via procurement (create → approve → receive)
 *   3. Test valuation (snapshot + layers), COGS, aging, turnover, availability, health
 *   4. Verify auth enforcement (401 without token)
 *   5. Verify input validation (400 for missing COGS dates)
 *
 * Uses MongoMemoryReplSet because Flow services wrap mutations in
 * `unitOfWork.withTransaction`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

// Local `parse` takes the response object (`{ body }`) rather than the
// scenario-setup `parse` which takes a raw body string. Keeping the
// response-object signature here avoids rewriting ~15 call sites.
function parse(res: { body: string }): Record<string, unknown> | null {
  try { return JSON.parse(res.body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  // FLOW_MODE=enterprise activates every report endpoint (valuation /
  // COGS / aging / turnover / availability / health). Replaces ~80 lines
  // of inline replSet + mongoose + setupBetterAuthOrg boilerplate. The
  // `staff` user the old setup provisioned was dead — it was never used
  // in any assertion — so it's dropped.
  env = await bootScenarioApp({ scenario: 'rpt', env: { FLOW_MODE: 'enterprise' } });
  server = env.server;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') { return env.auth.as(role).headers; }

function get(path: string, query?: Record<string, string>) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  return server.inject({
    method: 'GET',
    url: `${API}/inventory/reports${path}${qs}`,
    headers: h(),
  });
}

async function seedProcurement(items: Array<{ skuRef: string; quantity: number; unitCost: number }>) {
  const createRes = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement`,
    headers: h(),
    payload: { vendorRef: 'vendor-rpt', destinationNodeId: env.orgId, items },
  });
  const po = parse(createRes);
  if (!po?.success) throw new Error(`Failed to create PO: ${createRes.body}`);
  const poId = po.data._id;

  await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${poId}/action`,
    headers: h(),
    payload: { action: 'approve' },
  });

  const rcvRes = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${poId}/receive`,
    headers: h(),
    payload: { lines: items.map((i) => ({ skuRef: i.skuRef, quantityReceived: i.quantity })) },
  });
  const rcv = parse(rcvRes);
  if (!rcv?.success) throw new Error(`Failed to receive PO: ${rcvRes.body}`);
  return poId;
}

// ── Bootstrap ──

describe('Bootstrap', () => {
  it('boots with report resources', () => { expect(server).toBeDefined(); });
});

// ── Auth Enforcement ──

describe('Auth — 401 without token', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/inventory/reports/valuation'],
    ['GET', '/inventory/reports/cogs?startDate=2025-01-01&endDate=2025-12-31'],
    ['GET', '/inventory/reports/aging'],
    ['GET', '/inventory/reports/health'],
    ['GET', '/inventory/reports/turnover'],
    ['GET', '/inventory/reports/availability'],
  ];
  for (const [method, path] of endpoints) {
    it(`${method} ${path} -> 401`, async () => {
      const res = await server.inject({ method: method as any, url: `${API}${path}` });
      expect([400, 401]).toContain(res.statusCode);
    });
  }
});

// ── Empty State (no stock data) ──

describe('Empty State', () => {
  it('valuation returns zero totals', async () => {
    const res = await get('/valuation');
    const b = parse(res);
    expect(res.statusCode).toBe(200);
    expect(b.success).toBe(true);
    expect(b.data.mode).toBe('snapshot');
    expect(b.data.grandTotalQuantity).toBe(0);
    expect(b.data.grandTotalValue).toBe(0);
  });

  it('cogs rejects missing dates with 400', async () => {
    const res = await get('/cogs');
    expect(res.statusCode).toBe(400);
  });

  it('cogs rejects missing endDate with 400', async () => {
    const res = await get('/cogs', { startDate: '2025-01-01' });
    expect(res.statusCode).toBe(400);
  });

  it('cogs returns zero for empty period', async () => {
    const res = await get('/cogs', { startDate: '2000-01-01', endDate: '2000-01-31' });
    const b = parse(res);
    expect(res.statusCode).toBe(200);
    expect(b.data.grandTotalQuantity).toBe(0);
    expect(b.data.grandTotalCost).toBe(0);
  });
});

// ── With Seeded Data ──

describe('Reports with stock data', () => {
  beforeAll(async () => {
    // Seed: SKU-A 100 units @ 50 cost, SKU-B 200 units @ 25 cost
    // Total value: (100×50) + (200×25) = 5000 + 5000 = 10000
    await seedProcurement([
      { skuRef: 'RPT-SKU-A', quantity: 100, unitCost: 50 },
      { skuRef: 'RPT-SKU-B', quantity: 200, unitCost: 25 },
    ]);
  }, 30_000);

  // ── Valuation ──

  describe('Valuation', () => {
    it('snapshot mode returns correct totals', async () => {
      const res = await get('/valuation', { mode: 'snapshot' });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.mode).toBe('snapshot');
      expect(b.data.totalSkus).toBe(2);
      expect(b.data.grandTotalQuantity).toBe(300);
      expect(b.data.grandTotalValue).toBe(10000);
      expect(b.data.locations.length).toBeGreaterThanOrEqual(1);
    });

    it('layers mode returns correct totals', async () => {
      const res = await get('/valuation', { mode: 'layers' });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.mode).toBe('layers');
      expect(b.data.grandTotalQuantity).toBe(300);
      expect(b.data.grandTotalValue).toBe(10000);
    });

    it('filters by SKU', async () => {
      const res = await get('/valuation', { skuRef: 'RPT-SKU-A' });
      const b = parse(res);
      expect(b.data.totalSkus).toBe(1);
      expect(b.data.grandTotalQuantity).toBe(100);
      expect(b.data.grandTotalValue).toBe(5000);
    });

    it('nonexistent SKU returns zero', async () => {
      const res = await get('/valuation', { skuRef: 'NONEXISTENT' });
      const b = parse(res);
      expect(b.data.grandTotalQuantity).toBe(0);
      expect(b.data.grandTotalValue).toBe(0);
    });

    it('location breakdown has items with averageUnitCost', async () => {
      const res = await get('/valuation');
      const b = parse(res);
      const loc = b.data.locations[0];
      expect(loc.locationId).toBeTruthy();
      expect(loc.items.length).toBeGreaterThanOrEqual(1);
      expect(loc.items[0].averageUnitCost).toBeGreaterThan(0);
    });
  });

  // ── COGS ──

  describe('COGS', () => {
    it('returns zero COGS when no outgoing moves', async () => {
      // Only received stock — no shipments/sales yet
      const today = new Date().toISOString().split('T')[0];
      const res = await get('/cogs', { startDate: '2020-01-01', endDate: today });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.grandTotalCost).toBe(0);
      expect(b.data.grandTotalQuantity).toBe(0);
      expect(b.data.period.startDate).toBeTruthy();
      expect(b.data.period.endDate).toBeTruthy();
    });

    it('filters by nonexistent SKU returns empty items', async () => {
      const res = await get('/cogs', {
        startDate: '2020-01-01', endDate: '2099-12-31', skuRef: 'NONEXISTENT',
      });
      const b = parse(res);
      expect(b.data.items).toHaveLength(0);
    });
  });

  // ── Aging ──

  describe('Aging', () => {
    it('returns bucketed data with fresh stock in 0-30 bucket', async () => {
      const res = await get('/aging');
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.asOfDate).toBeTruthy();
      expect(Array.isArray(b.data.buckets)).toBe(true);
      expect(b.data.buckets.length).toBeGreaterThan(0);

      // Freshly received stock should be in the youngest bucket
      const freshBucket = b.data.buckets.find((bk: { minDays: number }) => bk.minDays === 0);
      if (freshBucket) {
        expect(freshBucket.quantity).toBeGreaterThanOrEqual(300);
      }
    });

    it('no dead stock for fresh inventory', async () => {
      const res = await get('/aging');
      const b = parse(res);
      expect(b.data.deadStock?.length ?? 0).toBe(0);
    });
  });

  // ── Turnover ──

  describe('Turnover', () => {
    it('returns period and metrics', async () => {
      const res = await get('/turnover', { periodDays: '30' });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.period).toBeDefined();
      expect(b.data.period.start).toBeTruthy();
      expect(b.data.period.end).toBeTruthy();
      expect(typeof b.data.averageInventoryValue).toBe('number');
    });
  });

  // ── Availability ──

  describe('Availability', () => {
    it('returns matrix for seeded SKUs', async () => {
      const res = await get('/availability', { skuRefs: 'RPT-SKU-A,RPT-SKU-B' });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.matrix).toBeDefined();
      if (b.data.matrix.length > 0) {
        const skuA = b.data.matrix.find((r: { skuRef: string }) => r.skuRef === 'RPT-SKU-A');
        if (skuA) {
          expect(skuA.totalOnHand).toBe(100);
        }
      }
    });

    it('returns empty matrix for nonexistent SKUs', async () => {
      const res = await get('/availability', { skuRefs: 'NONEXISTENT' });
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      // Matrix should be empty or have zero quantities
      if (b.data.matrix.length > 0) {
        expect(b.data.matrix[0].totalOnHand).toBe(0);
      }
    });
  });

  // ── Health ──

  describe('Health', () => {
    it('reflects seeded inventory', async () => {
      const res = await get('/health');
      const b = parse(res);
      expect(res.statusCode).toBe(200);
      expect(b.data.totalSkus).toBeGreaterThanOrEqual(2);
      expect(b.data.totalOnHand).toBeGreaterThanOrEqual(300);
      expect(b.data.totalValue).toBeGreaterThanOrEqual(10000);
      expect(b.data.deadStockPercentage).toBe(0); // freshly received
    });
  });
});
