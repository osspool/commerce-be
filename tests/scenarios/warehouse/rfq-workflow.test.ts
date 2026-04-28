/**
 * RFQ workflow (T3.2).
 *
 * Locks the full lifecycle:
 *   create → send → 3 vendors submit responses → compare ranks → award →
 *   bridge listener creates PO → recordPoGenerated stamps back-ref →
 *   `order:rfq.po_generated` fires.
 *
 * Auth: bootScenarioApp's admin already has branch-staff perms which
 * `permissions.orderActions.updateStatus` accepts.
 *
 * Stock seeding: each vendor's winning lines need a matching catalog SKU;
 * the bridge resolves skuRef from the original `RfqLineItem` so we seed
 * one product per RFQ line.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const SKU_A = 'RFQ-SKU-A';
const SKU_B = 'RFQ-SKU-B';
const API = '/api/v1';

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'rfq', env: { FLOW_MODE: 'standard' } });
  server = env.server;

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed two catalog products. The award bridge looks up skuRef on each
  // `RfqLineItem` and uses it as the procurement order's `skuRef`. Without
  // a matching catalog product the procurement create might still succeed
  // (procurement doesn't always validate catalog), but seeding keeps the
  // pipeline realistic.
  const ts = Date.now();
  for (const [sku, name] of [[SKU_A, 'RFQ Widget A'], [SKU_B, 'RFQ Widget B']]) {
    await db.collection('catalog_products').insertOne({
      name,
      slug: `${sku.toLowerCase()}-${ts}`,
      productType: 'physical',
      status: 'active',
      defaultMonetization: { pricing: { basePrice: { amount: 1000, currency: 'BDT' } } },
      identifiers: { custom: { sku } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Boot inventory event handlers + RFQ bridge — bootScenarioApp doesn't
  // call initializeBackgroundRuntime, so handlers / cron stay off by
  // default. We need the bridge.
  const { registerRfqAwardBridge } = await import('#resources/sales/rfq/events/award-bridge.js');
  registerRfqAwardBridge();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h() {
  return env.auth.as('admin').headers;
}

async function createRfq() {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/rfqs`,
    headers: h(),
    payload: {
      lineItems: [
        { lineId: 'L1', skuRef: SKU_A, description: 'Widget A', quantity: 100 },
        { lineId: 'L2', skuRef: SKU_B, description: 'Widget B', quantity: 50 },
      ],
      invitedVendors: [
        { vendorId: 'VEN-1', vendorName: 'Acme Supplies' },
        { vendorId: 'VEN-2', vendorName: 'Beta Imports' },
        { vendorId: 'VEN-3', vendorName: 'Gamma Trade' },
      ],
      validUntil: new Date('2027-01-01').toISOString(),
      notes: 'Q1 procurement bid',
    },
  });
  if (res.statusCode >= 400) throw new Error(`RFQ create failed: ${res.statusCode} ${res.body}`);
  return parse(res.body)!.data as { rfqNumber: string; status: string };
}

function action(rfqNumber: string, payload: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: `${API}/rfqs/${rfqNumber}/action`,
    headers: h(),
    payload,
  });
}

describe('RFQ workflow (T3.2)', () => {
  it('end-to-end: send → 3 responses → compare → award → PO generated', async () => {
    const rfq = await createRfq();
    expect(rfq.status).toBe('draft');
    expect(rfq.rfqNumber).toMatch(/^RFQ-\d{4}-\d+$/);

    // Send to vendors
    const sent = await action(rfq.rfqNumber, { action: 'send' });
    expect(sent.statusCode).toBe(200);
    expect(parse(sent.body)!.data).toMatchObject({ status: 'sent' });

    // VEN-1: cheapest, longest lead-time
    const r1 = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 80, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 60, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 11000, currency: 'BDT' }, // 80*100 + 60*50
      leadTimeDays: 21,
    });
    expect(r1.statusCode).toBe(200);
    expect(parse(r1.body)!.data).toMatchObject({ status: 'comparing' });

    // VEN-2: middle
    const r2 = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-2',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 90, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 65, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 12250, currency: 'BDT' }, // 90*100 + 65*50
      leadTimeDays: 7,
    });
    expect(r2.statusCode).toBe(200);

    // VEN-3: priciest, fastest
    const r3 = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-3',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 100, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 70, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 13500, currency: 'BDT' }, // 100*100 + 70*50
      leadTimeDays: 3,
    });
    expect(r3.statusCode).toBe(200);

    // Compare — 3 rankings, 0 missing
    const cmp = await action(rfq.rfqNumber, { action: 'compare' });
    expect(cmp.statusCode).toBe(200);
    const cmpData = parse(cmp.body)!.data as {
      rankings: Array<{ vendorId: string; score: number }>;
      missingResponses: number;
    };
    expect(cmpData.missingResponses).toBe(0);
    expect(cmpData.rankings).toHaveLength(3);
    // Rankings sorted ascending by score (lower = better blend)
    for (let i = 0; i + 1 < cmpData.rankings.length; i++) {
      expect(cmpData.rankings[i]!.score).toBeLessThanOrEqual(cmpData.rankings[i + 1]!.score);
    }

    // Award VEN-2 (the balanced choice)
    const awarded = await action(rfq.rfqNumber, {
      action: 'award',
      vendorId: 'VEN-2',
      rationale: 'best price/lead-time blend',
    });
    expect(awarded.statusCode).toBe(200);
    const awardedDoc = parse(awarded.body)!.data as { status: string; award?: { vendorId: string } };
    expect(awardedDoc.status).toBe('awarded');
    expect(awardedDoc.award?.vendorId).toBe('VEN-2');

    // Wait for the async award bridge to fire — flow.procurement.create
    // wraps a transaction, so allow ample time.
    let bridgeFired = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 250));
      const final = await server.inject({
        method: 'GET',
        url: `${API}/rfqs/${rfq.rfqNumber}`,
        headers: h(),
      });
      const finalDoc = parse(final.body)!.data as { generatedPoRef?: { poNumber?: string } };
      if (finalDoc.generatedPoRef?.poNumber) {
        bridgeFired = true;
        expect(finalDoc.generatedPoRef.poNumber).toMatch(/^PO-/);
        break;
      }
    }
    expect(bridgeFired).toBe(true);
  }, 180_000);

  it('rejects submitResponse from a vendor that was not invited', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });

    const res = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-OUTSIDER',
      lines: [{ lineId: 'L1', unitPrice: { amount: 50, currency: 'BDT' }, quantity: 100 }],
      totalPrice: { amount: 5000, currency: 'BDT' },
      leadTimeDays: 5,
    });
    expect(res.statusCode).toBe(403);
    expect(parse(res.body)!.code).toBe('RFQ_VENDOR_NOT_INVITED');
  }, 120_000);

  it('rejects award when vendor has not submitted a response', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });
    // Get one response so the RFQ enters `comparing` (award is only valid there)
    await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [{ lineId: 'L1', unitPrice: { amount: 50, currency: 'BDT' }, quantity: 100 }],
      totalPrice: { amount: 5000, currency: 'BDT' },
      leadTimeDays: 5,
    });

    const res = await action(rfq.rfqNumber, { action: 'award', vendorId: 'VEN-2' });
    expect(res.statusCode).toBe(422);
    expect(parse(res.body)!.code).toBe('RFQ_AWARD_WITHOUT_RESPONSE');
  }, 120_000);

  it('rejects line-total mismatch on submitResponse', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });

    const res = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [{ lineId: 'L1', unitPrice: { amount: 80, currency: 'BDT' }, quantity: 100 }],
      // Should be 8000; declaring 9999 trips the integrity check
      totalPrice: { amount: 9999, currency: 'BDT' },
      leadTimeDays: 21,
    });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)!.code).toBe('RFQ_RESPONSE_TOTAL_MISMATCH');
  }, 120_000);

  it('cancel transitions to terminal and blocks further actions', async () => {
    const rfq = await createRfq();
    const cancelled = await action(rfq.rfqNumber, { action: 'cancel', reason: 'budget cut' });
    expect(cancelled.statusCode).toBe(200);
    expect(parse(cancelled.body)!.data).toMatchObject({ status: 'cancelled' });

    const blocked = await action(rfq.rfqNumber, { action: 'send' });
    expect(blocked.statusCode).toBe(422);
  }, 120_000);

  // ── Extra HTTP-level edges ────────────────────────────────────────────

  it('vendor revises their quote — last-write-wins, response count stays at 1', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });

    // First quote — slow + pricey
    const r1 = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 100, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 70, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 13500, currency: 'BDT' },
      leadTimeDays: 21,
    });
    expect(r1.statusCode).toBe(200);
    const after1 = parse(r1.body)!.data as { responses: Array<unknown> };
    expect(after1.responses).toHaveLength(1);

    // Vendor revises — sharper + faster
    const r2 = await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 80, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 60, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 11000, currency: 'BDT' },
      leadTimeDays: 7,
    });
    expect(r2.statusCode).toBe(200);
    const after2 = parse(r2.body)!.data as {
      responses: Array<{ vendorId: string; leadTimeDays: number; totalPrice: { amount: number } }>;
    };
    expect(after2.responses).toHaveLength(1);
    expect(after2.responses[0]!.leadTimeDays).toBe(7);
    expect(after2.responses[0]!.totalPrice.amount).toBe(11000);
  }, 120_000);

  it('compare ranks responses correctly, sorted ascending by score', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });

    // VEN-1: cheap + slow
    await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 80, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 60, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 11000, currency: 'BDT' },
      leadTimeDays: 21,
    });
    // VEN-3: pricey + fast
    await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-3',
      lines: [
        { lineId: 'L1', unitPrice: { amount: 100, currency: 'BDT' }, quantity: 100 },
        { lineId: 'L2', unitPrice: { amount: 70, currency: 'BDT' }, quantity: 50 },
      ],
      totalPrice: { amount: 13500, currency: 'BDT' },
      leadTimeDays: 3,
    });

    const res = await action(rfq.rfqNumber, { action: 'compare' });
    expect(res.statusCode).toBe(200);
    const data = parse(res.body)!.data as {
      rankings: Array<{ vendorId: string; score: number; expired: boolean }>;
      missingResponses: number;
    };
    expect(data.rankings).toHaveLength(2);
    // VEN-2 was invited but didn't respond
    expect(data.missingResponses).toBe(1);
    // Sorted ascending — lower score = better blend
    for (let i = 0; i + 1 < data.rankings.length; i++) {
      expect(data.rankings[i]!.score).toBeLessThanOrEqual(data.rankings[i + 1]!.score);
    }
    // Neither response expired
    expect(data.rankings.every((r) => !r.expired)).toBe(true);
  }, 120_000);

  it('award is terminal — second award attempt is rejected', async () => {
    const rfq = await createRfq();
    await action(rfq.rfqNumber, { action: 'send' });
    await action(rfq.rfqNumber, {
      action: 'submit_response',
      vendorId: 'VEN-1',
      lines: [{ lineId: 'L1', unitPrice: { amount: 100, currency: 'BDT' }, quantity: 100 }],
      totalPrice: { amount: 10000, currency: 'BDT' },
      leadTimeDays: 7,
    });

    const first = await action(rfq.rfqNumber, { action: 'award', vendorId: 'VEN-1' });
    expect(first.statusCode).toBe(200);

    const second = await action(rfq.rfqNumber, { action: 'award', vendorId: 'VEN-1' });
    expect(second.statusCode).toBe(422);
  }, 120_000);

  it('cancelled RFQ cannot be re-cancelled (idempotent terminal)', async () => {
    const rfq = await createRfq();
    const first = await action(rfq.rfqNumber, { action: 'cancel', reason: 'first time' });
    expect(first.statusCode).toBe(200);

    const second = await action(rfq.rfqNumber, { action: 'cancel', reason: 'second time' });
    expect(second.statusCode).toBe(422);
    expect(parse(second.body)!.code).toBe('RFQ_ALREADY_TERMINAL');
  }, 120_000);

  it('GET /rfqs lists tenant-scoped — created RFQ shows up', async () => {
    const rfq = await createRfq();
    const res = await server.inject({
      method: 'GET',
      url: `${API}/rfqs`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body) as { docs?: Array<{ rfqNumber: string }> };
    const numbers = (body.docs ?? []).map((d) => d.rfqNumber);
    expect(numbers).toContain(rfq.rfqNumber);
  }, 120_000);

  it('unknown action name on a real RFQ returns 400 (not 404 — proves the route is wired)', async () => {
    const rfq = await createRfq();
    const res = await action(rfq.rfqNumber, { action: 'no_such_action' });
    expect(res.statusCode).toBe(400);
  }, 120_000);

  it('send rejects RFQ with no invitedVendors — caught at create time', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/rfqs`,
      headers: h(),
      payload: {
        lineItems: [{ lineId: 'L1', skuRef: SKU_A, description: 'Widget', quantity: 10 }],
        invitedVendors: [], // empty — should be rejected by Arc body validation
      },
    });
    // Arc's auto-validation rejects with 400 before the kernel sees it
    expect([400, 422]).toContain(res.statusCode);
  }, 120_000);
});
