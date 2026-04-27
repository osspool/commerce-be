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
import { bootScenarioApp, type ScenarioEnv, type TestAuthProvider } from '../../support/scenario-setup.js';
import type { FastifyInstance } from 'fastify';

// ── Setup ──────────────────────────────────────────────────────────────────
//
// `procurementService.executeReceive` runs inside a Mongo transaction (it
// dispatches Flow moves + writes the receipt MoveGroup atomically). Mongo
// transactions require a replica set, so this suite uses `bootScenarioApp`
// which spins up a MongoMemoryReplSet.

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: TestAuthProvider;
let orgId: string;
const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'grn-e2e',
    env: { FLOW_MODE: 'standard' },
  });
  server = env.server;
  auth = env.auth;
  orgId = env.orgId;
}, 180_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

// ── Helpers ──

async function createProcurement(items: Array<{ skuRef: string; quantity: number; unitCost: number }>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement`,
    headers: auth.as('admin').headers,
    payload: {
      vendorRef: 'vendor-001',
      destinationNodeId: orgId,
      items,
    },
  });
  return parse(res.body);
}

async function approveProcurement(id: string) {
  return server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/action`,
    headers: auth.as('admin').headers,
    payload: { action: 'approve' },
  });
}

async function receiveProcurement(id: string, lines: Array<{ skuRef: string; quantityReceived: number }>) {
  return server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/receive`,
    headers: auth.as('admin').headers,
    payload: { lines },
  });
}

async function getMatchStatus(id: string) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/inventory/procurement/${id}/match-status`,
    headers: auth.as('admin').headers,
  });
  return parse(res.body);
}

async function reportInvoiced(id: string, lines: Array<{ lineIndex: number; skuRef: string; quantityInvoiced: number; billRef?: string }>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/report-invoiced`,
    headers: auth.as('admin').headers,
    payload: { lines },
  });
  return parse(res.body);
}

async function validateMatch(id: string, tolerance?: Record<string, number>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/validate-match`,
    headers: auth.as('admin').headers,
    payload: tolerance ? { tolerance } : {},
  });
  return parse(res.body);
}

async function getReceiptMoves(id: string) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/inventory/procurement/${id}/receipt-moves`,
    headers: auth.as('admin').headers,
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
    if (!body?.success) {
      // Expose the actual response when the receive call fails so the
      // assertion message is actionable instead of `false ≠ true`.
      throw new Error(`procurement receive failed: ${res.statusCode} ${res.body}`);
    }
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
      headers: auth.as('admin').headers,
      payload: { lines: [{ lineIndex: 99, skuRef: 'SKU-WIDGET-A', quantityInvoiced: 10 }] },
    });
    // Flow ValidationError is now mapped to 400 via the defineErrorMapper
    // in create-arc-app-options.ts (client-caused, not 500).
    expect([400, 500]).toContain(res.statusCode);
  });

  it('rejects SKU mismatch', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/report-invoiced`,
      headers: auth.as('admin').headers,
      payload: { lines: [{ lineIndex: 0, skuRef: 'WRONG-SKU', quantityInvoiced: 10 }] },
    });
    expect([400, 500]).toContain(res.statusCode);
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
