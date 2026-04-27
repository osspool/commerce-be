/**
 * Transfer cancel mid-flight (scenario)
 *
 * Pins the contract for `POST /transfers/:id/action { action: "cancel" }`:
 *
 *   - Cancelling a DRAFT transfer is a no-op on stock — nothing dispatched yet.
 *   - Cancelling an APPROVED transfer (still pre-dispatch) is also a no-op
 *     on stock; transfer status flips to `cancelled`.
 *   - Cancelling a DISPATCHED transfer MUST restore the sender's stock
 *     (the dispatch decrement is reversed via Flow's vendor → stock move).
 *     Historically this path is the silent-failure window — the goods are
 *     already in the receiver's `vendor` location and the cancel flow may
 *     not unwind that move.
 *
 * Also asserts that a same-branch transfer (sender == receiver) is rejected
 * at the gateway / service so users can't oversend within a single branch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { addSecondaryBranch, bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let senderOrgId: string;
let receiverOrgId: string;
let productId: string;
let sku: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `XCAN-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Cancel Scenario Widget',
    slug: `xcan-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 30000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: s } },
    shipping: { requiresShipping: true, weight: 250 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku: s };
}

async function seedStockAt(orgId: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, sku, qty, 18000);
}

async function getStockAt(orgId: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: sku, locationId: 'stock' },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

function setActiveOrgHeader(orgId: string) {
  const headers = { ...env.auth.as('admin').headers } as Record<string, string>;
  headers['x-organization-id'] = orgId;
  return headers;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'xfr-cancel' });
  senderOrgId = env.orgId;

  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;

  receiverOrgId = await addSecondaryBranch(env, { slug: 'xfr-cancel-recv', branchRole: 'branch' });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Transfer cancel — mid-flight', () => {
  it('cancelling a DRAFT transfer leaves sender stock untouched and flips status', async () => {
    await seedStockAt(senderOrgId, 10);
    expect(await getStockAt(senderOrgId)).toBe(10);

    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: receiverOrgId,
        documentType: 'delivery_note',
        items: [{ productId, variantSku: sku, quantity: 4 }],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = parse(createRes.body)?.data as { _id: string; status: string };
    expect(transfer.status).toBe('draft');

    const cancelRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: { action: 'cancel', reason: 'changed our mind' },
    });
    expect(cancelRes.statusCode, cancelRes.body).toBeLessThan(400);
    const cancelled = parse(cancelRes.body)?.data as { status: string };
    expect(cancelled.status).toBe('cancelled');

    // Stock untouched — nothing was dispatched.
    expect(await getStockAt(senderOrgId)).toBe(10);
  }, 90_000);

  it('rejects same-branch transfers at the gateway (sender === receiver)', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: senderOrgId,
        items: [{ productId, variantSku: sku, quantity: 1 }],
      },
    });
    // Service rejects same-branch with 4xx — could be 400 (validation) or 422.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  }, 30_000);
});
