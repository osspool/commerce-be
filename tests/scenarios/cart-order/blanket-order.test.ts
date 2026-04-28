/**
 * Blanket Order — sales-side standing order (T3.1).
 *
 * Locks the composition contract:
 *   - POST /blanket-orders creates an active blanket with cadence + lines
 *   - release_drawdown manually generates a child Order; consumedQty bumps
 *   - hitting totalCommitmentQty auto-transitions to `exhausted`
 *   - drawdown on a terminal blanket → 422
 *   - close action cancels the blanket; subsequent drawdowns → 422
 *   - extend pushes cadence.endAt; rejected on terminal blankets
 *
 * Uses the same `bootScenarioApp` harness as procurement-approval-chain.
 * Each drawdown runs the full order pipeline (catalog snapshot, totals,
 * flow reservation), so we seed a product + stock up-front.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let productId: string;
const SKU = 'BLK-SKU-001';
const API = '/api/v1';

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'blanket', env: { FLOW_MODE: 'standard' } });
  server = env.server;

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed a catalog product so each drawdown's order pipeline can resolve the
  // line snapshot through the catalog bridge.
  const ts = Date.now();
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Blanket Test Widget',
    slug: `blanket-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 1000, currency: 'BDT' } } },
    identifiers: { custom: { sku: SKU } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  productId = prod.insertedId.toString();

  // Plenty of stock — flow.bridge reserves one unit per drawdown line.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock } = await import('../../support/erp-seed.js');
  await seedStock(getFlowEngine(), env.orgId, SKU, 100, 1000);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h() {
  return env.auth.as('admin').headers;
}

function blanketPayload(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'b2b',
    orderType: 'standard',
    customerId: `cust-blanket-${Date.now()}`,
    customer: {
      name: 'Blanket Co. Ltd',
      email: 'ops@blanket.test',
    },
    cadence: {
      kind: 'monthly',
      interval: 1,
      dayOfMonth: 1,
      startAt: new Date('2026-01-01').toISOString(),
      endAt: new Date('2027-01-01').toISOString(),
    },
    lines: [
      {
        kind: 'sku',
        offerId: productId,
        quantity: 1,
        unitPriceOverride: { amount: 1000, currency: 'BDT' },
      },
    ],
    ...overrides,
  };
}

async function createBlanket(payload: Record<string, unknown>) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/blanket-orders`,
    headers: h(),
    payload,
  });
  if (res.statusCode >= 400) {
    throw new Error(`Blanket create failed: ${res.statusCode} ${res.body}`);
  }
  return parse(res.body)!.data as {
    blanketNumber: string;
    status: string;
    consumedQty: number;
    totalCommitmentQty?: number;
  };
}

function action(blanketNumber: string, payload: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: `${API}/blanket-orders/${blanketNumber}/action`,
    headers: h(),
    payload,
  });
}

describe('Blanket Order (T3.1) — sales-side standing order', () => {
  it('drawdowns bump consumedQty and auto-exhaust on commitment', async () => {
    const blanket = await createBlanket(blanketPayload({ totalCommitmentQty: 3 }));
    expect(blanket.status).toBe('active');
    expect(blanket.blanketNumber).toMatch(/^BLK-\d{4}-\d+$/);
    expect(blanket.consumedQty).toBe(0);

    // 3 successful drawdowns
    for (let i = 1; i <= 3; i++) {
      const res = await action(blanket.blanketNumber, { action: 'release_drawdown' });
      if (res.statusCode !== 200) {
        throw new Error(`Drawdown ${i} failed: ${res.statusCode} ${res.body}`);
      }
      const body = parse(res.body)!.data as {
        blanket: { consumedQty: number; status: string };
        order: { orderNumber?: string } | null;
      };
      expect(body.order).not.toBeNull();
      expect(body.blanket.consumedQty).toBe(i);
    }

    // 4th drawdown — kernel auto-transitioned the blanket to exhausted at the
    // tail of the 3rd generate, so this hits BLANKET_ORDER_INVALID_TRANSITION.
    const blocked = await action(blanket.blanketNumber, { action: 'release_drawdown' });
    expect(blocked.statusCode).toBe(422);
    expect(parse(blocked.body)!.code).toBe('BLANKET_ORDER_INVALID_TRANSITION');

    // Verify the blanket is in a terminal state
    const final = await server.inject({
      method: 'GET',
      url: `${API}/blanket-orders/${blanket.blanketNumber}`,
      headers: h(),
    });
    const finalDoc = parse(final.body)!.data as { status: string; consumedQty: number };
    expect(finalDoc.status).toBe('exhausted');
    expect(finalDoc.consumedQty).toBe(3);
  }, 120_000);

  it('close action cancels an active blanket and blocks further drawdowns', async () => {
    const blanket = await createBlanket(blanketPayload());

    // One drawdown to prove the blanket is functional pre-close
    const ok = await action(blanket.blanketNumber, { action: 'release_drawdown' });
    expect(ok.statusCode).toBe(200);

    const closed = await action(blanket.blanketNumber, {
      action: 'close',
      reason: 'commitment fulfilled out-of-band',
    });
    expect(closed.statusCode).toBe(200);
    expect(parse(closed.body)!.data).toMatchObject({ status: 'cancelled' });

    const blockedDraw = await action(blanket.blanketNumber, { action: 'release_drawdown' });
    expect(blockedDraw.statusCode).toBe(422);

    const blockedExtend = await action(blanket.blanketNumber, {
      action: 'extend',
      endAt: new Date('2028-01-01').toISOString(),
    });
    expect(blockedExtend.statusCode).toBe(422);
    expect(parse(blockedExtend.body)!.code).toBe('BLANKET_ORDER_ALREADY_TERMINAL');
  }, 120_000);

  it('extend pushes cadence.endAt forward; rejects past dates', async () => {
    const blanket = await createBlanket(blanketPayload());

    // endAt earlier than current → 400
    const stale = await action(blanket.blanketNumber, {
      action: 'extend',
      endAt: new Date('2026-06-01').toISOString(),
    });
    expect(stale.statusCode).toBe(400);

    const newEnd = new Date('2028-06-01').toISOString();
    const extended = await action(blanket.blanketNumber, {
      action: 'extend',
      endAt: newEnd,
    });
    expect(extended.statusCode).toBe(200);
    const updated = parse(extended.body)!.data as { cadence: { endAt: string } };
    expect(new Date(updated.cadence.endAt).toISOString()).toBe(newEnd);
  }, 120_000);
});
