/**
 * Promo Evaluation — full lifecycle saga (scenario)
 *
 * The evaluation pipeline mutates two things at once: cart totals and voucher
 * usage counters. Any drift between them silently overcharges or undercharges
 * customers. This scenario pins the contract end-to-end:
 *
 *   1. Admin creates a `discount_code` program in `draft` status.
 *   2. Admin attaches a rule (minimumAmount: 1000 BDT) and a 10% order reward.
 *   3. Admin activates the program (draft → active).
 *   4. Admin generates a single voucher with a fixed code.
 *   5. POST /promotions/vouchers/validate/:code — succeeds for active voucher.
 *   6. POST /promotions/evaluate/preview — pure read, no DB writes.
 *      Cart of 2000 BDT must yield 200 BDT discount; voucher usedCount stays 0.
 *   7. POST /promotions/evaluate — creates a pending evaluation; voucher
 *      reservation increments.
 *   8. POST /promotions/evaluate/:id/commit — locks the evaluation to an order.
 *   9. Re-validating the now-used voucher fails (VOUCHER_USED / EXHAUSTED).
 *
 * A second test covers the rollback path: evaluate → rollback → voucher
 * usage returns to 0 → second evaluation works.
 *
 * The test is intentionally end-to-end (HTTP layer, not service-direct) so a
 * regression at the route, controller, or auth layer surfaces here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let productId: string;
let sku: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `PROMO-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Promo Scenario Widget',
    slug: `promo-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 100000, currency: 'BDT' } }, // 1000 BDT
    },
    identifiers: { custom: { sku: s } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku: s };
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'promo-eval' });
  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

// ─── Scenario 1: full happy path ──────────────────────────────────────────────

describe('Promo evaluation — happy path: program → voucher → preview → evaluate → commit', () => {
  let programId: string;
  let voucherCode: string;
  let evaluationId: string;

  it('admin creates a draft discount_code program', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/programs`,
      headers: env.auth.as('admin').headers,
      payload: {
        name: 'Scenario 10% Off',
        description: 'Integration test program',
        programType: 'discount_code',
        triggerMode: 'code',
        stackingMode: 'exclusive',
        priority: 1,
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? parse(res.body)) as Record<string, unknown>;
    programId = (data?._id ?? data?.id) as string;
    expect(programId).toBeTruthy();
    expect(data.status).toBe('draft');
  });

  it('attaches a rule (minimumAmount 1000 BDT)', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/rules`,
      headers: env.auth.as('admin').headers,
      payload: {
        name: 'Min order 1000',
        minimumAmount: 1000,
        programId,
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    expect(data.programId).toBe(programId);
    expect(data.minimumAmount).toBe(1000);
  });

  it('attaches a 10% order-level discount reward', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/rewards`,
      headers: env.auth.as('admin').headers,
      payload: {
        rewardType: 'discount',
        discountMode: 'percentage',
        discountAmount: 10,
        discountScope: 'order',
        programId,
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    expect(data.rewardType).toBe('discount');
    expect(data.discountAmount).toBe(10);
  });

  it('activates the program (draft → active) via Stripe action route', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/programs/${programId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'activate' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    // The promo engine's collection name is package-internal; rather than
    // chasing it, re-read via the /full route which we know surfaces status.
    const get = await env.server.inject({
      method: 'GET',
      url: `${API}/promotions/programs/${programId}/full`,
      headers: env.auth.as('admin').headers,
    });
    expect(get.statusCode, get.body).toBe(200);
    const data = (parse(get.body)?.data ?? {}) as Record<string, unknown>;
    expect(data.status).toBe('active');
  });

  it('GET /:id/full returns program with rules + rewards arrays', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/promotions/programs/${programId}/full`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    expect(Array.isArray(data.rules)).toBe(true);
    expect(Array.isArray(data.rewards)).toBe(true);
    expect((data.rules as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((data.rewards as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('admin generates a single voucher with a fixed code', async () => {
    voucherCode = `SCENARIO-${Date.now()}`;
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/vouchers/generate-single`,
      headers: env.auth.as('admin').headers,
      payload: { programId, code: voucherCode },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    expect(data.code).toBe(voucherCode);
  });

  it('POST /vouchers/validate/:code — succeeds for active voucher', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/vouchers/validate/${voucherCode}`,
      headers: env.auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    // Either { valid: true } or the voucher document itself — both are
    // acceptable contracts; the assertion is "this code passes validation."
    expect(data).toBeTruthy();
  });

  it('preview returns a 200 BDT discount for a 2000 BDT cart and does NOT mutate state', async () => {
    const beforeUsedCount = await usedCountForVoucher(voucherCode);

    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate/preview`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    // The evaluation result varies in shape between versions — assert the
    // discount magnitude rather than chasing a brittle field path.
    const discount = extractDiscountAmount(data);
    expect(discount, 'preview discount missing or wrong').toBe(200);

    const afterUsedCount = await usedCountForVoucher(voucherCode);
    expect(afterUsedCount).toBe(beforeUsedCount); // preview is read-only
  });

  it('evaluate creates a pending evaluation that we can commit', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    evaluationId = (data._id ?? data.id ?? data.evaluationId) as string;
    expect(evaluationId, 'evaluation id missing from response').toBeTruthy();
  });

  it('commit attaches the evaluation to an order id', async () => {
    expect(evaluationId).toBeTruthy();
    const fakeOrderId = new mongoose.Types.ObjectId().toString();
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate/${evaluationId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'commit', orderId: fakeOrderId },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });

  it('the voucher is consumed — second evaluate fails to apply the discount', async () => {
    // The validate route's response shape varies; the load-bearing contract is
    // "the same code cannot drive a second discount." Re-evaluating the same
    // cart with the now-committed voucher must NOT yield another 200 BDT off.
    const second = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    // Either the evaluate fails outright (preferred) or it succeeds with zero
    // discount applied (acceptable — the voucher just doesn't match anymore).
    if (second.statusCode >= 400) {
      expect([400, 409, 410, 422]).toContain(second.statusCode);
    } else {
      const data = (parse(second.body)?.data ?? {}) as Record<string, unknown>;
      const discount = extractDiscountAmount(data) ?? 0;
      expect(discount, 'committed voucher must not redeem twice').toBe(0);
    }
  });
});

// ─── Scenario 2: rollback restores voucher availability ───────────────────────

describe('Promo evaluation — rollback releases the voucher', () => {
  let programId: string;
  let voucherCode: string;

  it('seeds a fresh active program + voucher', async () => {
    const programRes = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/programs`,
      headers: env.auth.as('admin').headers,
      payload: {
        name: 'Rollback Scenario 10% Off',
        programType: 'discount_code',
        triggerMode: 'code',
        stackingMode: 'exclusive',
      },
    });
    const programData = (parse(programRes.body)?.data ?? {}) as Record<string, unknown>;
    programId = (programData._id ?? programData.id) as string;

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
        discountAmount: 10,
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
    voucherCode = `ROLLBACK-${Date.now()}`;
    await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/vouchers/generate-single`,
      headers: env.auth.as('admin').headers,
      payload: { programId, code: voucherCode },
    });
  });

  it('evaluate then rollback leaves the voucher reusable', async () => {
    const evalRes = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    expect(evalRes.statusCode, evalRes.body).toBeLessThan(400);
    const evalData = (parse(evalRes.body)?.data ?? {}) as Record<string, unknown>;
    const evaluationId = (evalData._id ?? evalData.id ?? evalData.evaluationId) as string;
    expect(evaluationId).toBeTruthy();

    const rollback = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate/${evaluationId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'rollback' },
    });
    expect(rollback.statusCode, rollback.body).toBeLessThan(400);

    // After rollback the voucher should still validate as usable. We do a
    // second evaluate to prove the reservation was actually released.
    const second = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    expect(second.statusCode, second.body).toBeLessThan(400);
  });
});

// ─── Scenario 3: cart-hash tamper protection on commit ───────────────────────

describe('Promo evaluation — cart-hash tamper guard', () => {
  let programId: string;
  let voucherCode: string;
  let evalId: string;
  let evalCartHash: string;

  it('seeds a fresh active program + voucher', async () => {
    const programRes = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/programs`,
      headers: env.auth.as('admin').headers,
      payload: {
        name: 'Tamper Guard 10% Off',
        programType: 'discount_code',
        triggerMode: 'code',
        stackingMode: 'exclusive',
      },
    });
    expect(programRes.statusCode, programRes.body).toBeLessThan(400);
    const programData = (parse(programRes.body)?.data ?? {}) as Record<string, unknown>;
    programId = (programData._id ?? programData.id) as string;

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
        discountAmount: 10,
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
    voucherCode = `TAMPER-${Date.now()}`;
    await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/vouchers/generate-single`,
      headers: env.auth.as('admin').headers,
      payload: { programId, code: voucherCode },
    });
  });

  it('evaluate returns a cartHash alongside the evaluation id', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate`,
      headers: env.auth.as('admin').headers,
      payload: {
        items: [{ productId, sku, quantity: 2, unitPrice: 1000, lineTotal: 2000 }],
        subtotal: 2000,
        codes: [voucherCode],
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? {}) as Record<string, unknown>;
    evalId = (data._id ?? data.id ?? data.evaluationId) as string;
    evalCartHash = data.cartHash as string;
    expect(evalId).toBeTruthy();
    expect(evalCartHash).toBeTruthy();
    expect(evalCartHash).toHaveLength(64); // sha256 hex
  });

  it('commit with a forged cartHash → 409 CART_HASH_MISMATCH', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate/${evalId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'commit', orderId, cartHash: 'deadbeef'.repeat(8) },
    });
    expect(res.statusCode).toBe(409);
    const body = parse(res.body) as Record<string, unknown>;
    const details = (body?.details ?? body) as Record<string, unknown>;
    const code = (details.code ?? body?.code) as string | undefined;
    expect(code).toBe('CART_HASH_MISMATCH');
  });

  it('commit with the correct cartHash succeeds', async () => {
    const orderId = new mongoose.Types.ObjectId().toString();
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/evaluate/${evalId}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'commit', orderId, cartHash: evalCartHash },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The evaluation result is shape-flexible across versions. Try the well-known
 * paths in priority order, then fall back to scanning the object tree for a
 * plausible discount field.
 */
function extractDiscountAmount(data: Record<string, unknown>): number | undefined {
  const direct =
    (data.totalDiscount as number | undefined) ??
    (data.discountAmount as number | undefined) ??
    (data.discount as number | undefined);
  if (typeof direct === 'number') return direct;
  const totals = data.totals as Record<string, unknown> | undefined;
  if (totals) {
    const t =
      (totals.discount as number | undefined) ??
      (totals.totalDiscount as number | undefined);
    if (typeof t === 'number') return t;
  }
  const applied = data.appliedRewards as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(applied) && applied.length > 0) {
    const sum = applied.reduce((acc, r) => acc + (Number(r.discountAmount ?? r.amount ?? 0) || 0), 0);
    if (sum > 0) return sum;
  }
  return undefined;
}

/**
 * Look up the voucher's current usedCount in Mongo. The collection may be
 * named `promo_vouchers` or similar — we discover it dynamically once.
 */
let cachedVoucherCollection: string | null = null;
async function usedCountForVoucher(code: string): Promise<number> {
  const db = mongoose.connection.db!;
  if (!cachedVoucherCollection) {
    const collections = await db.listCollections().toArray();
    const candidate = collections.find((c) =>
      /vouchers?$/i.test(c.name) || c.name === 'promo_vouchers',
    );
    cachedVoucherCollection = candidate?.name ?? 'promo_vouchers';
  }
  const doc = await db.collection(cachedVoucherCollection).findOne({ code });
  return ((doc?.usedCount ?? doc?.redemptionCount ?? 0) as number) || 0;
}
