/**
 * GRN + 3-Way Matching E2E Integration Tests
 *
 * Covers:
 *   1. Procurement order creation + approval + receiving (GRN = receipt MoveGroup)
 *   2. procurementLineIndex stored on receipt moves
 *   3. Match status endpoint — pending → received → partial → matched
 *   4. Report invoiced — push billed quantities into Flow matching
 *   5. Validate match — 3-way validation with tolerance
 *   6. Receipt moves by line — GRN traceability
 *   7. Variance detection — over-invoice triggers match.variance_detected
 *   8. SKU mismatch / invalid line index rejection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ── Setup ──────────────────────────────────────────────────────────────────

let ctx: TestOrgContext;
let auth: AuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  await col.deleteMany({});
  await col.insertOne({
    isSingleton: true,
    platformName: 'GRN E2E Store',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.FLOW_MODE = 'standard';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }

  await seedPlatformConfig();

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const ts = Date.now();

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
    org: { name: `GrnE2E-${ts}`, slug: `grn-e2e-${ts}` },
    users: [
      { key: 'admin', email: `grn-adm-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({
    tokens: { admin: ctx.users.admin.token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  await mongoose.connection.db!.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ── Helpers ──

async function createProcurement(items: Array<{ skuRef: string; quantity: number; unitCost: number }>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement`,
    headers: auth.getHeaders('admin'),
    payload: {
      vendorRef: 'vendor-001',
      destinationNodeId: ctx.orgId,
      items,
    },
  });
  return parse(res.body);
}

async function approveProcurement(id: string) {
  return server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/action`,
    headers: auth.getHeaders('admin'),
    payload: { action: 'approve' },
  });
}

async function receiveProcurement(id: string, lines: Array<{ skuRef: string; quantityReceived: number }>) {
  return server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/receive`,
    headers: auth.getHeaders('admin'),
    payload: { lines },
  });
}

async function getMatchStatus(id: string) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/inventory/procurement/${id}/match-status`,
    headers: auth.getHeaders('admin'),
  });
  return parse(res.body);
}

async function reportInvoiced(id: string, lines: Array<{ lineIndex: number; skuRef: string; quantityInvoiced: number; billRef?: string }>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/report-invoiced`,
    headers: auth.getHeaders('admin'),
    payload: { lines },
  });
  return parse(res.body);
}

async function validateMatch(id: string, tolerance?: Record<string, number>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/validate-match`,
    headers: auth.getHeaders('admin'),
    payload: tolerance ? { tolerance } : {},
  });
  return parse(res.body);
}

async function getReceiptMoves(id: string) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/inventory/procurement/${id}/receipt-moves`,
    headers: auth.getHeaders('admin'),
  });
  return parse(res.body);
}

// ── Tests ──

describe('GRN + 3-Way Matching E2E', () => {
  let poId: string;

  it('creates a procurement order', async () => {
    const result = await createProcurement([
      { skuRef: 'SKU-WIDGET-A', quantity: 100, unitCost: 500 },
      { skuRef: 'SKU-WIDGET-B', quantity: 50, unitCost: 300 },
    ]);
    expect(result.success).toBe(true);
    expect(result.data.orderNumber).toMatch(/^PO-/);
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0].quantityInvoiced).toBe(0);
    poId = result.data._id;
  });

  it('match status is pending before receipt', async () => {
    const result = await getMatchStatus(poId);
    expect(result.success).toBe(true);
    expect(result.data.fullyMatched).toBe(false);
    expect(result.data.lines[0].status).toBe('pending');
    expect(result.data.lines[1].status).toBe('pending');
  });

  it('approves the procurement order', async () => {
    const res = await approveProcurement(poId);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('approved');
  });

  it('receives goods (creates GRN via Flow receipt)', async () => {
    const res = await receiveProcurement(poId, [
      { skuRef: 'SKU-WIDGET-A', quantityReceived: 100 },
      { skuRef: 'SKU-WIDGET-B', quantityReceived: 50 },
    ]);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('received');
  });

  it('match status shows received after goods receipt', async () => {
    const result = await getMatchStatus(poId);
    expect(result.success).toBe(true);
    expect(result.data.fullyMatched).toBe(false);
    expect(result.data.lines[0].status).toBe('received');
    expect(result.data.lines[0].quantityReceived).toBe(100);
    expect(result.data.lines[0].quantityToInvoice).toBe(100);
    expect(result.data.lines[1].status).toBe('received');
    expect(result.data.lines[1].quantityToInvoice).toBe(50);
  });

  it('receipt moves are grouped by PO line index', async () => {
    const result = await getReceiptMoves(poId);
    expect(result.success).toBe(true);
    // Line 0 = SKU-WIDGET-A, Line 1 = SKU-WIDGET-B
    expect(result.data['0']).toBeDefined();
    expect(result.data['1']).toBeDefined();
    expect(result.data['0'][0].quantity).toBe(100);
    expect(result.data['1'][0].quantity).toBe(50);
  });

  it('reports partial invoice (vendor bill for line 0 only)', async () => {
    const result = await reportInvoiced(poId, [
      { lineIndex: 0, skuRef: 'SKU-WIDGET-A', quantityInvoiced: 100, billRef: 'BILL-001' },
    ]);
    expect(result.success).toBe(true);
    expect(result.data.fullyMatched).toBe(false);
    expect(result.data.lines[0].status).toBe('matched');
    expect(result.data.lines[1].status).toBe('received'); // not yet invoiced
  });

  it('validate match fails when not fully invoiced', async () => {
    const result = await validateMatch(poId);
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
  });

  it('reports full invoice (both lines)', async () => {
    const result = await reportInvoiced(poId, [
      { lineIndex: 0, skuRef: 'SKU-WIDGET-A', quantityInvoiced: 100 },
      { lineIndex: 1, skuRef: 'SKU-WIDGET-B', quantityInvoiced: 50 },
    ]);
    expect(result.success).toBe(true);
    expect(result.data.fullyMatched).toBe(true);
    expect(result.data.lines[0].status).toBe('matched');
    expect(result.data.lines[1].status).toBe('matched');
  });

  it('validate match passes when fully matched', async () => {
    const result = await validateMatch(poId);
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
    expect(result.data.variances).toHaveLength(0);
  });

  it('rejects invalid line index', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/report-invoiced`,
      headers: auth.getHeaders('admin'),
      payload: { lines: [{ lineIndex: 99, skuRef: 'SKU-WIDGET-A', quantityInvoiced: 10 }] },
    });
    const body = parse(res.body);
    expect(res.statusCode).toBe(500); // ValidationError from Flow
  });

  it('rejects SKU mismatch', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/report-invoiced`,
      headers: auth.getHeaders('admin'),
      payload: { lines: [{ lineIndex: 0, skuRef: 'WRONG-SKU', quantityInvoiced: 10 }] },
    });
    expect(res.statusCode).toBe(500); // ValidationError from Flow
  });
});

describe('GRN Variance Detection', () => {
  let poId: string;

  it('creates and receives a PO for variance test', async () => {
    const created = await createProcurement([
      { skuRef: 'SKU-VAR-A', quantity: 100, unitCost: 500 },
    ]);
    poId = created.data._id;
    await approveProcurement(poId);
    await receiveProcurement(poId, [
      { skuRef: 'SKU-VAR-A', quantityReceived: 100 },
    ]);
  });

  it('detects over-invoice variance', async () => {
    const result = await reportInvoiced(poId, [
      { lineIndex: 0, skuRef: 'SKU-VAR-A', quantityInvoiced: 120 },
    ]);
    expect(result.success).toBe(true);
    expect(result.data.lines[0].status).toBe('over_invoiced');
  });

  it('validate match fails with over-invoice variance', async () => {
    const result = await validateMatch(poId);
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(false);
    expect(result.data.variances).toHaveLength(1);
    expect(result.data.variances[0].status).toBe('over_invoiced');
  });

  it('validate match passes with lenient tolerance', async () => {
    const result = await validateMatch(poId, {
      quantityOverInvoiceTolerance: 0.25,
    });
    expect(result.success).toBe(true);
    expect(result.data.valid).toBe(true);
  });
});
