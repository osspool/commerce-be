/**
 * Purchase receive — all-or-nothing contract (scenario)
 *
 * Pins what the current backend ACTUALLY does (vs. what the audit hoped
 * for): `POST /inventory/purchase-orders/:id/action { action: 'receive' }`
 * receives EVERY line on the PO in one shot. There is no per-line
 * `items[]` parameter and no `partial_received` state — the FSM goes
 * `draft|approved → received`, end of story.
 *
 * Why test this even though it's not the "rich" partial-receipt path
 * the audit imagined: this test will fail loudly the day someone adds
 * partial-receipt support and forgets to update either:
 *   - the purchase FSM (no `partial_received` enum value today)
 *   - the action schema (no `items` field accepted today)
 *   - this contract assumption
 *
 * Compare with `transfer.service.receiveTransfer` which DOES take a
 * per-line `items[]` array — these two services intentionally diverge,
 * and that divergence should be visible in the test suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let orgId: string;
let productAId: string;
let productBId: string;

async function seedProduct(slug: string): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `PAON-${slug}-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: `Purchase All-or-Nothing ${slug}`,
    slug: `paon-${slug.toLowerCase()}-${ts}`,
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

async function getStock(skuRef: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef, locationId: 'stock' },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

function authH() {
  return env.auth.as('admin').headers as Record<string, string>;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'paon' });
  orgId = env.orgId;

  const a = await seedProduct('A');
  const b = await seedProduct('B');
  productAId = a.id;
  productBId = b.id;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Purchase receive — all-or-nothing', () => {
  it('receive flips status to RECEIVED and posts ALL line items in one shot', async () => {
    // Create a multi-line draft PO. Service computes invoiceNumber, totals,
    // etc. — `paymentTerms: cash` keeps it simple (no due-date logic).
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: authH(),
      payload: {
        paymentTerms: 'cash',
        items: [
          // Products seeded without `variants[]` — passing `variantSku`
          // would trigger "Variant not found" in `_normalizeItems`. The
          // catalog bridge falls back to `productId` for the skuRef.
          { productId: productAId, quantity: 4, costPrice: 100 },
          { productId: productBId, quantity: 7, costPrice: 50 },
        ],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const purchase = parse(createRes.body)?.data as { _id: string; status: string };
    expect(purchase.status).toBe('draft');

    // Pre-receive: both SKUs at zero stock. The skuRef Flow uses for a
    // variantless product is the productId itself (see `skuRefFromProduct`).
    expect(await getStock(productAId)).toBe(0);
    expect(await getStock(productBId)).toBe(0);

    // Receive — no `items` payload, no per-line control. Whole PO posts.
    const receiveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchase._id}/action`,
      headers: authH(),
      payload: { action: 'receive' },
    });
    expect(receiveRes.statusCode, receiveRes.body).toBeLessThan(400);
    const received = parse(receiveRes.body)?.data as { status: string };
    expect(received.status).toBe('received');

    // Both lines posted to stock — proves all-or-nothing semantics.
    expect(await getStock(productAId)).toBe(4);
    expect(await getStock(productBId)).toBe(7);

    // Calling receive a second time MUST 4xx — the FSM rejects the
    // transition from `received` (only `draft` / `approved` allowed).
    const second = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchase._id}/action`,
      headers: authH(),
      payload: { action: 'receive' },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeLessThan(500);

    // Stock unchanged after the rejected re-receive — no double-posting.
    expect(await getStock(productAId)).toBe(4);
    expect(await getStock(productBId)).toBe(7);
  }, 90_000);
});
