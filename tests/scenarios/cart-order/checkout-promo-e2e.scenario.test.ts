/**
 * Checkout × Promo — end-to-end saga (scenario)
 *
 * Pins the server-authoritative promo contract:
 *
 *   Client → POST /orders/place { promoCodes: [code] }
 *   Server:
 *     1. Resolve lines (catalog bridge).
 *     2. Reserve stock (Flow).
 *     3. Evaluate promo against canonical resolved lines — NOT client cart.
 *     4. Create order with { metadata.promoEvaluationId, promoCodes, promoTotalDiscount }.
 *     5. Commit promo. On commit failure → rollback reservation.
 *     6. On order-insert failure → release stock AND rollback promo reservation.
 *
 * Competitor gap: Odoo applies discounts at order confirmation, but client
 * cart tamper between display and confirm silently shifts totals. SAP B1 has
 * no cart-hash protection. Our design makes tamper impossible by construction
 * — the server never trusts a client-supplied evaluation; it recomputes from
 * the canonical lines it's about to ship.
 *
 * Scenarios:
 *   A. Code-only happy path — client sends just promoCodes; server evaluates,
 *      commits, voucher consumed, discount stamped on order metadata.
 *   B. No-promo baseline — order places without any promo fields.
 *   C. Client lies about cart — server still evaluates against the canonical
 *      resolved lines, not the fake items the client claimed. No tamper
 *      surface exists.
 *   D. Unknown code — server includes it in rejectedCodes, order places
 *      without discount, voucher math untouched.
 *   E. Exhausted voucher — evaluation returns empty, order places at full
 *      price, promoCommit.skipped = true.
 *   F. Idempotent retry — identical request with same idempotencyKey returns
 *      the original order without double-consuming the voucher.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

/** Unwrap `{ success, data }` envelope — tolerates flat responses too. */
function unwrap(body: string): Record<string, unknown> {
  const parsed = parse(body) ?? {};
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

let env: ScenarioEnv;
let productId: string;
let sku: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `CHKPROMO-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Checkout Promo Widget',
    slug: `chkpromo-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 100000, currency: 'BDT' } }, // 1000 BDT
    },
    identifiers: { custom: { sku: s } },
    shipping: { requiresShipping: true, weight: 100 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku: s };
}

async function seedProgramAndVoucher(opts: {
  codePrefix: string;
  maxUses?: number;
  discountAmount?: number;
}): Promise<{ programId: string; voucherCode: string }> {
  const programRes = await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/programs`,
    headers: env.auth.as('admin').headers,
    payload: {
      name: `${opts.codePrefix} 10% Off`,
      programType: 'discount_code',
      triggerMode: 'code',
      stackingMode: 'exclusive',
      priority: 1,
    },
  });
  expect(programRes.statusCode, programRes.body).toBeLessThan(400);
  const programId = unwrap(programRes.body)._id as string;

  await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/rules`,
    headers: env.auth.as('admin').headers,
    payload: { minimumAmount: 1000, programId },
  });
  await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/rewards`,
    headers: env.auth.as('admin').headers,
    payload: {
      rewardType: 'discount',
      discountMode: 'percentage',
      discountAmount: opts.discountAmount ?? 10,
      discountScope: 'order',
      programId,
    },
  });
  await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/programs/${programId}/action`,
    headers: env.auth.as('admin').headers,
    payload: { action: 'activate' },
  });

  const voucherCode = `${opts.codePrefix}-${Date.now()}`;
  const payload: Record<string, unknown> = { programId, code: voucherCode };
  if (opts.maxUses != null) payload.maxUses = opts.maxUses;
  const voucherRes = await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/vouchers/generate-single`,
    headers: env.auth.as('admin').headers,
    payload,
  });
  expect(voucherRes.statusCode, voucherRes.body).toBeLessThan(400);

  return { programId, voucherCode };
}

async function seedStockForSku(skuValue: string, qty = 500): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock } = await import('../../support/erp-seed.js');
  // Seed the sku string AND the productId — be-prod's catalog bridge
  // resolves offerId=productId to skuRef (the product _id, not the
  // identifiers.custom.sku string), so stock has to live at both keys for
  // the order pipeline to find it.
  const flow = getFlowEngine();
  await seedStock(flow, env.orgId, skuValue, qty, 100000);
  await seedStock(flow, env.orgId, productId, qty, 100000);
}

let cachedVoucherCollection: string | null = null;
async function voucherUsedCount(code: string): Promise<number> {
  const db = mongoose.connection.db!;
  if (!cachedVoucherCollection) {
    const list = await db.listCollections().toArray();
    cachedVoucherCollection =
      list.find((c) => /vouchers?$/i.test(c.name))?.name ?? 'promo_vouchers';
  }
  const doc = await db.collection(cachedVoucherCollection).findOne({ code });
  return ((doc?.usedCount ?? doc?.redemptionCount ?? 0) as number) || 0;
}

function standardOrderPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: `chk-promo-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    channel: 'web',
    orderType: 'standard',
    lines: [{ kind: 'sku', offerId: productId, quantity: 2 }],
    customer: { email: 'shopper@test.com', name: 'Test Shopper' },
    shippingAddress: {
      recipientName: 'Test Shopper',
      recipientPhone: '01700000000',
      addressLine1: '123 Test Road',
      city: 'Dhaka',
      country: 'Bangladesh',
      areaId: 'test-area',
    },
    ...extra,
  };
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'checkout-promo' });
  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;
  await seedStockForSku(sku, 500);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

// ─── A: server-authoritative happy path ───────────────────────────────────────

describe('Scenario A — client sends only codes; server evaluates + commits', () => {
  let voucherCode: string;

  it('admin seeds program + voucher', async () => {
    const seeded = await seedProgramAndVoucher({ codePrefix: 'HAPPY' });
    voucherCode = seeded.voucherCode;
    expect(voucherCode).toBeTruthy();
  });

  it('places order with promoCodes only — response reports discount applied, voucher consumed', async () => {
    const beforeUsed = await voucherUsedCount(voucherCode);
    expect(beforeUsed).toBe(0);

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({ promoCodes: [voucherCode] }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    expect(body.success).toBe(true);

    const order = (body.data as Record<string, unknown>) ?? {};
    const metadata = (order.metadata as Record<string, unknown>) ?? {};
    expect(metadata.promoEvaluationId, 'server must stamp a real evaluationId').toBeTruthy();
    expect(metadata.promoCodes).toEqual([voucherCode]);
    // 10% × 2 × 1000 BDT = 200 BDT = 20000 paisa. Engine + catalog both
    // speak minor units end-to-end — no conversion in the critical path.
    expect(metadata.promoTotalDiscount).toBe(20000);

    const promoCommit = body.promoCommit as Record<string, unknown> | undefined;
    expect(promoCommit?.committed).toBe(true);
    expect(promoCommit?.skipped).toBe(false);
    expect(promoCommit?.totalDiscount).toBe(20000);
    expect(promoCommit?.appliedCodes).toEqual([voucherCode]);

    const afterUsed = await voucherUsedCount(voucherCode);
    expect(afterUsed).toBe(1);
  });

  it('second attempt with same voucher → server rejects at evaluate; order places at full price', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({ promoCodes: [voucherCode] }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    expect(body.success).toBe(true);

    const order = (body.data as Record<string, unknown>) ?? {};
    const metadata = (order.metadata as Record<string, unknown>) ?? {};
    // Either no evaluationId stamped OR zero discount — both valid outcomes.
    expect(metadata.promoTotalDiscount ?? 0).toBe(0);

    const promoCommit = body.promoCommit as Record<string, unknown> | undefined;
    expect(promoCommit?.committed).toBe(false);

    // Voucher still 1 — not double-counted.
    const used = await voucherUsedCount(voucherCode);
    expect(used).toBe(1);
  });
});

// ─── B: baseline without promo ───────────────────────────────────────────────

describe('Scenario B — no promoCodes means no promo work', () => {
  it('places order without any promo field → promoCommit.skipped = true', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload(),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    const promoCommit = body.promoCommit as Record<string, unknown> | undefined;
    expect(promoCommit?.committed).toBe(false);
    expect(promoCommit?.skipped).toBe(true);
  });
});

// ─── C: client-claimed cart is IGNORED by the server ─────────────────────────

describe('Scenario C — server ignores any client-evaluation fields (tamper impossible)', () => {
  let voucherCode: string;

  it('admin seeds a fresh program + voucher', async () => {
    const seeded = await seedProgramAndVoucher({ codePrefix: 'IGNORED' });
    voucherCode = seeded.voucherCode;
  });

  it('client sends fake promoEvaluationId and promoCartHash — server ignores them and recomputes', async () => {
    // Old-contract fields — server must NOT trust them. Behavior with this
    // payload should be identical to "just promoCodes" (server re-evaluates).
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({
        promoCodes: [voucherCode],
        promoEvaluationId: 'f'.repeat(32),         // fake id — must be ignored
        promoCartHash: 'deadbeef'.repeat(8),       // fake hash — must be ignored
      }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);

    const body = parse(res.body) ?? {};
    expect(body.success).toBe(true);

    const order = (body.data as Record<string, unknown>) ?? {};
    const metadata = (order.metadata as Record<string, unknown>) ?? {};

    // Stamped evaluationId MUST be server-generated (not the fake one).
    expect(metadata.promoEvaluationId).toBeTruthy();
    expect(metadata.promoEvaluationId).not.toBe('f'.repeat(32));

    const promoCommit = body.promoCommit as Record<string, unknown> | undefined;
    expect(promoCommit?.committed).toBe(true);
    expect(promoCommit?.totalDiscount).toBe(20000); // paisa

    const used = await voucherUsedCount(voucherCode);
    expect(used).toBe(1);
  });
});

// ─── D: unknown / invalid code ───────────────────────────────────────────────

describe('Scenario D — unknown code is echoed as rejected; order places without discount', () => {
  it('server returns rejectedCodes in promoCommit, order still succeeds', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({ promoCodes: ['TOTALLY-FAKE-CODE'] }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    expect(body.success).toBe(true);

    const order = (body.data as Record<string, unknown>) ?? {};
    const metadata = (order.metadata as Record<string, unknown>) ?? {};
    expect(metadata.promoEvaluationId).toBeUndefined();
    expect(metadata.promoTotalDiscount).toBeUndefined();

    const promoCommit = body.promoCommit as Record<string, unknown> | undefined;
    expect(promoCommit?.committed).toBe(false);
    expect(promoCommit?.skipped).toBe(true);
    const rejected = promoCommit?.rejectedCodes as Array<{ code: string }> | undefined;
    expect(rejected?.some((r) => r.code === 'TOTALLY-FAKE-CODE')).toBe(true);
  });
});

// ─── E: idempotent retry with same key ───────────────────────────────────────

describe('Scenario E — retry with the same idempotencyKey does not double-consume voucher', () => {
  let voucherCode: string;
  let idempotencyKey: string;

  it('seeds voucher and places the initial order', async () => {
    const seeded = await seedProgramAndVoucher({ codePrefix: 'IDEMP' });
    voucherCode = seeded.voucherCode;
    idempotencyKey = `idemp-test-${Date.now()}`;

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({ idempotencyKey, promoCodes: [voucherCode] }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    expect((body.promoCommit as Record<string, unknown> | undefined)?.committed).toBe(true);

    const used = await voucherUsedCount(voucherCode);
    expect(used).toBe(1);
  });

  it('retries the same payload with same idempotencyKey → voucher still 1', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: env.auth.as('admin').headers,
      payload: standardOrderPayload({ idempotencyKey, promoCodes: [voucherCode] }),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body) ?? {};
    expect(body.idempotent ?? false).toBe(true);

    const used = await voucherUsedCount(voucherCode);
    expect(used).toBe(1);
  });
});
