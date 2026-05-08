/**
 * Transfer receive — per-line `destinationLocationId` override (scenario)
 *
 * Pins the receiver-side bin routing contract:
 *
 *   - On receive, when `items[i].destinationLocationId` is supplied, the
 *     received qty lands in THAT bin in the receiver scope, not the
 *     receiver's default `stock` bin.
 *   - The default `stock` bin is unaffected by the override — proves the
 *     resolver isn't fanning out to multiple bins.
 *
 * The dispatch side already has its own coverage in
 * `inventory-transfer-location.scenario.test.ts`. This file is the
 * mirror image: same primitive, opposite scope (receiver context, not
 * sender). Without this, a regression in `transfer.service.ts:422`
 * (`receivedItem?.destinationLocationId ?? item.destinationLocationId`)
 * would silently route receipts to the default bin and nobody would
 * notice until inventory at a specific aisle was off.
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
let receiverSubLocationCode: string;
let receiverSubLocationId: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `XRCV-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Receive-Location Widget',
    slug: `xrcv-widget-${ts}`,
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

async function getStockAtLocation(orgId: string, locationCode: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: sku, locationId: locationCode },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

/** Create an extra physical sub-location in the receiver branch so we have somewhere to route receipts. */
async function createReceiverSubLocation(): Promise<{ code: string; id: string }> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const flow = getFlowEngine();
  const node = await flow.repositories.node.getByQuery(
    { isDefault: true },
    { organizationId: receiverOrgId, throwOnNotFound: false, lean: true },
  );
  const code = `RCV-AISLE-${Date.now()}`;
  const created = (await flow.repositories.location.create(
    {
      organizationId: receiverOrgId,
      nodeId: String(node!._id),
      code,
      name: 'Receiver Aisle A',
      type: 'storage',
      status: 'active',
      allowNegativeStock: false,
      allowReservations: false,
    },
    { organizationId: receiverOrgId },
  )) as { _id: unknown };
  return { code, id: String(created._id) };
}

function setActiveOrgHeader(orgId: string) {
  const headers = { ...env.auth.as('admin').headers } as Record<string, string>;
  headers['x-organization-id'] = orgId;
  return headers;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'xfr-rcv-loc' });
  senderOrgId = env.orgId;

  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;

  receiverOrgId = await addSecondaryBranch(env, { slug: 'xrcv-receiver', branchRole: 'branch' });

  const sub = await createReceiverSubLocation();
  receiverSubLocationCode = sub.code;
  receiverSubLocationId = sub.id;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Transfer receive — per-line destinationLocationId override (receiver scope)', () => {
  it('routes received qty to the specified sub-location, default stock bin untouched', async () => {
    await seedStockAt(senderOrgId, 12);

    // 1. Create + approve + dispatch a transfer of 5 units.
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(senderOrgId),
      payload: {
        senderBranchId: senderOrgId,
        receiverBranchId: receiverOrgId,
        documentType: 'delivery_note',
        items: [{ productId, variantSku: sku, quantity: 5 }],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = parse(createRes.body) as {
      _id: string;
      items: Array<{ _id: string }>;
    };

    for (const action of ['approve', 'dispatch'] as const) {
      const r = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/transfers/${transfer._id}/action`,
        headers: setActiveOrgHeader(senderOrgId),
        payload: { action, transport: action === 'dispatch' ? { notes: 'internal' } : undefined },
      });
      expect(r.statusCode, `action=${action} failed: ${r.body}`).toBeLessThan(400);
    }

    // Receiver default stock and the new sub-location both start at 0.
    expect(await getStockAtLocation(receiverOrgId, 'stock')).toBe(0);
    expect(await getStockAtLocation(receiverOrgId, receiverSubLocationCode)).toBe(0);

    // 2. Receive into the sub-location bin via per-line override.
    const itemId = transfer.items[0]._id;
    const receiveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(receiverOrgId),
      payload: {
        action: 'receive',
        items: [
          {
            itemId,
            productId,
            variantSku: sku,
            quantityReceived: 5,
            destinationLocationId: receiverSubLocationId,
          },
        ],
      },
    });
    expect(receiveRes.statusCode, receiveRes.body).toBeLessThan(400);
    expect((parse(receiveRes.body) as { status: string }).status).toBe('received');

    // 3. Sub-location got all 5; default stock bin remains at 0.
    expect(await getStockAtLocation(receiverOrgId, receiverSubLocationCode)).toBe(5);
    expect(await getStockAtLocation(receiverOrgId, 'stock')).toBe(0);
  }, 90_000);
});
