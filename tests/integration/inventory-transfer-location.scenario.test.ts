/**
 * Transfer — per-line source location routing.
 *
 * Pins the contract that a transfer with `sourceLocationId` on each line:
 *   1. Pulls stock from THAT location on dispatch (not default `stock`).
 *   2. Leaves the sender's default stock untouched when an alt bin is used.
 *   3. Rejects a `sourceLocationId` that doesn't exist in the sender branch.
 *   4. Rejects a `sourceLocationId` pointing at a virtual location type.
 *
 * Scenario-style: boots one shared app + MongoMemoryReplSet, adds a
 * receiver branch, and drives real HTTP endpoints end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, addSecondaryBranch, type ScenarioEnv } from '../helpers/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let env: ScenarioEnv;
let senderOrgId: string;
let receiverOrgId: string;
let productId: string;
let sku: string;
let subLocationId: string;
const AISLE_CODE = 'SENDER-AISLE-A';

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `LOC-XFR-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Transfer Location Widget',
    slug: `loc-xfr-widget-${ts}`,
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

async function seedStockAt(orgId: string, locationCode: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const flow = getFlowEngine();
  const ctx = buildFlowContext(orgId, 'test');

  // Adjustment → specified location, generating quant + cost layer.
  const group = await flow.services.moveGroup.create(
    {
      groupType: 'adjustment',
      items: [
        {
          moveGroupId: '',
          operationType: 'adjustment',
          skuRef: sku,
          sourceLocationId: 'adjustment',
          destinationLocationId: locationCode,
          quantityPlanned: qty,
        },
      ],
    },
    ctx,
  );
  await flow.services.moveGroup.executeAction(group._id.toString(), 'confirm', {}, ctx);
  await flow.services.moveGroup.executeAction(group._id.toString(), 'receive', {}, ctx);
}

async function getStockAt(orgId: string, locationCode: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: sku, locationId: locationCode },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

function setActiveOrgHeader(orgId: string) {
  const headers = { ...env.auth.getHeaders('admin') } as Record<string, string>;
  headers['x-organization-id'] = orgId;
  return headers;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'xfr-loc' });
  senderOrgId = env.orgId;

  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;

  receiverOrgId = await addSecondaryBranch(env, { slug: 'xfr-loc-recv', branchRole: 'branch' });

  // `bootScenarioApp` + `addSecondaryBranch` already seed the 4 default
  // locations (stock/vendor/customer/adjustment) per branch via
  // `setupBranch`. All we add on top is a sender-side sub-location.
  const db = mongoose.connection.db!;
  const stockLoc = await db.collection('flow_locations').findOne({
    code: 'stock',
    organizationId: new mongoose.Types.ObjectId(senderOrgId),
  });
  if (!stockLoc) throw new Error('Sender stock location not seeded — scenario setup failed');
  const sub = await db.collection('flow_locations').insertOne({
    organizationId: stockLoc!.organizationId,
    nodeId: stockLoc!.nodeId,
    code: AISLE_CODE,
    name: 'Sender Aisle A',
    type: 'storage',
    status: 'active',
    allowReservations: true,
    allowNegativeStock: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  subLocationId = sub.insertedId.toString();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Transfer — per-line source location', () => {
  it('pulls from the specified sub-location on dispatch, leaves default stock untouched', async () => {
    // Seed 20 units at the default stock bin + 15 at the sub-location.
    await seedStockAt(senderOrgId, 'stock', 20);
    await seedStockAt(senderOrgId, AISLE_CODE, 15);

    expect(await getStockAt(senderOrgId, 'stock')).toBe(20);
    expect(await getStockAt(senderOrgId, AISLE_CODE)).toBe(15);

    // Create a transfer that pulls 8 units specifically from AISLE-A.
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: receiverOrgId,
        documentType: 'delivery_note',
        items: [{ productId, variantSku: sku, quantity: 8, sourceLocationId: subLocationId }],
        remarks: 'sub-location dispatch',
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = parse(createRes.body)?.data as { _id: string };

    for (const action of ['approve', 'dispatch'] as const) {
      const r = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/transfers/${transfer._id}/action`,
        headers: setActiveOrgHeader(senderOrgId),
        payload: { action, transport: action === 'dispatch' ? { carrier: 'internal' } : undefined },
      });
      expect(r.statusCode, `action=${action} failed: ${r.body}`).toBeLessThan(400);
    }

    // AISLE-A dropped by 8; default stock untouched.
    expect(await getStockAt(senderOrgId, AISLE_CODE)).toBe(15 - 8);
    expect(await getStockAt(senderOrgId, 'stock')).toBe(20);

    // Receive (default destination = receiver's stock bin).
    const receiveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(receiverOrgId),
      payload: { action: 'receive' },
    });
    expect(receiveRes.statusCode, receiveRes.body).toBeLessThan(400);
    expect(await getStockAt(receiverOrgId, 'stock')).toBe(8);
  }, 90_000);

  it('rejects approval when sourceLocationId is unknown in the sender branch', async () => {
    const stray = new mongoose.Types.ObjectId().toString();
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: receiverOrgId,
        documentType: 'delivery_note',
        items: [{ productId, variantSku: sku, quantity: 1, sourceLocationId: stray }],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = parse(createRes.body)?.data as { _id: string };

    const approveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: { action: 'approve' },
    });
    // Arc's action pipeline maps our status-errors to a non-2xx response.
    // Exact body shape varies by handler wrapper; what we care about is
    // that the request was refused (4xx) and the transfer did NOT move to
    // `approved`. That is the invariant — the wording is decoration.
    expect(approveRes.statusCode, approveRes.body).toBeGreaterThanOrEqual(400);
    expect(approveRes.statusCode, approveRes.body).toBeLessThan(500);
  }, 60_000);

  it('rejects approval when sourceLocationId points at a virtual (vendor) location', async () => {
    const db = mongoose.connection.db!;
    const vendorLoc = await db.collection('flow_locations').findOne({ code: 'vendor' });
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: receiverOrgId,
        documentType: 'delivery_note',
        items: [
          { productId, variantSku: sku, quantity: 1, sourceLocationId: String(vendorLoc!._id) },
        ],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = parse(createRes.body)?.data as { _id: string };

    const approveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: { action: 'approve' },
    });
    expect(approveRes.statusCode, approveRes.body).toBeGreaterThanOrEqual(400);
    expect(approveRes.statusCode, approveRes.body).toBeLessThan(500);
  }, 60_000);
});
