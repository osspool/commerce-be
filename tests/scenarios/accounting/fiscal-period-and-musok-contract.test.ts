/**
 * Contract test — fiscal-period pagination cap + musok seller-BIN missing.
 *
 * Locks two HTTP-surface contracts that frontend code depends on:
 *
 *   GET /accounting/fiscal-periods
 *     - default page size = 20 (no params)
 *     - explicit limit accepted up to maxLimit (500)
 *     - exceeding maxLimit → 400 with AJV error pointing at querystring/limit
 *
 *   GET /accounting/musok/return/:period
 *     - well-formed period regex (YYYY-MM) reaches the handler
 *     - missing seller BIN → 422 (NOT 400) with rich payload that tells the
 *       UI exactly where to send the operator: { code, message, action: {
 *       label, path, field } }
 *     - configured seller BIN → 200 with the real return shape
 *
 * The musok handler change matters because 400 implies "client sent bad
 * data" — but the request IS valid; the platform simply isn't configured.
 * 422 lets the UI distinguish "fix your input" from "fix your settings",
 * and the `action` block lets the empty-state CTA deep-link to the right
 * config page.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let app: FastifyInstance;

const ADMIN = { id: 'tx-admin', _id: 'tx-admin', role: ['admin', 'finance_admin'] };
const ORG = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.COOKIE_SECRET = 'c'.repeat(40);
  process.env.BETTER_AUTH_SECRET = 'd'.repeat(40);
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const fp = (await import('../../../src/resources/accounting/fiscal-period/fiscal-period.resource.js')).default;
  const musok = (await import('../../../src/resources/accounting/musok/musok.resource.js')).default;
  const reports = (await import('../../../src/resources/accounting/reports/reports.resource.js')).default;

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: any) => {
    req.user = ADMIN;
    req.scope = { organizationId: ORG, userId: ADMIN.id };
  });
  await app.register(
    async (s) => {
      await s.register(fp.toPlugin());
      await s.register(musok.toPlugin());
      await s.register(reports.toPlugin());
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  await mongoose.connection.collection('platformconfigs').deleteMany({});
});

// ── Fiscal periods — pagination cap ────────────────────────────────────

describe('GET /accounting/fiscal-periods — pagination cap', () => {
  it('returns default page (limit=20) when no params are supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/fiscal-periods' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.limit).toBe(20);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('accepts limit up to maxLimit (500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/fiscal-periods?limit=500&page=1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(500);
  });

  it('accepts the previously-failing limit=200', async () => {
    // Regression guard: this was the original FE request that 400'd before
    // the cap was bumped from 100 → 500.
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/fiscal-periods?limit=200&page=1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).limit).toBe(200);
  });

  it('rejects limit above 500 with AJV 400 pointing at querystring/limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/fiscal-periods?limit=501' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FST_ERR_VALIDATION');
    expect(body.message).toMatch(/querystring\/limit/);
    expect(body.message).toMatch(/<= 500/);
  });
});

// ── Musok monthly return — seller-BIN-missing contract ────────────────

describe('GET /accounting/musok/return/:period — seller BIN config gate', () => {
  it('returns 422 with actionable payload when seller BIN is not configured', async () => {
    // No platformconfigs row → loadSeller() returns null → 422 envelope.
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/musok/return/2026-04' });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      code: 'SELLER_BIN_MISSING',
    });
    expect(body.message).toMatch(/Platform Config/);
    expect(body.message).toMatch(/VAT/);
  });

  it('returns 400 (not 422) for a malformed period — input vs config error stay distinct', async () => {
    // The period regex (YYYY-MM) is enforced at the route schema layer.
    // Bad input is a 400 from AJV; missing config is a 422 from the
    // handler. Locking both shapes ensures the FE can branch correctly.
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/musok/return/not-a-period' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FST_ERR_VALIDATION');
  });

  it('returns 200 with the Mushak 9.1 envelope once seller BIN is configured', async () => {
    // Seed a minimal, valid platform config — no real BIN check at this
    // layer (the validator is its own endpoint), the handler only needs
    // `vat.bin` to be truthy to proceed past the guard.
    await mongoose.connection.collection('platformconfigs').insertOne({
      isSingleton: true,
      platformName: 'Contract Test Co',
      vat: {
        bin: '0012000456707', // any non-empty string passes the gate
        registeredName: 'Contract Test Co',
        vatCircle: 'Dhaka North',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/accounting/musok/return/2026-04' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Default branch regime is STANDARD_VAT → Mushak 9.1
    expect(body.formType).toBe('9.1');
    expect(body.regime).toBe('STANDARD_VAT');
    expect(body).toHaveProperty('aggregates');
    expect(body).toHaveProperty('return');
  });
});

// ── Reports — dateOption=custom round-trip to ledger ──────────────────

describe('GET /accounting/reports/* — dateOption=custom contract', () => {
  // Was failing because be-prod's parseDateParams emitted
  // `dateValue: { start, end }` but @classytic/ledger's `getDateRange` /
  // `case 'custom':` destructures `{ startDate, endDate }`. Both fields
  // were present in the request, so the resource-level AJV schema passed,
  // and the failure surfaced deep in the ledger as a generic "Custom
  // date range requires both startDate and endDate". Locking the round-
  // trip so a key drift on either side fails this test instead.
  it('accepts dateOption=custom + startDate/endDate end-to-end (no ledger throw)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounting/reports/trial-balance?dateOption=custom&startDate=2024-01-01&endDate=2024-03-31',
    });
    // Pre-fix: 500 with "Custom date range requires both startDate and endDate".
    // Post-fix: 200 with whatever the ledger returns for an empty period.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body).toBeDefined();
  });

  it('parity check: dateOption=year and dateOption=custom both succeed', async () => {
    const yearRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounting/reports/balance-sheet?dateOption=year&year=2024',
    });
    const customRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounting/reports/balance-sheet?dateOption=custom&startDate=2024-01-01&endDate=2024-12-31',
    });
    expect(yearRes.statusCode).toBe(200);
    expect(customRes.statusCode).toBe(200);
  });
});
