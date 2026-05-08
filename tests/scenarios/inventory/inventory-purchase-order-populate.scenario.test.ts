/**
 * Purchase Order — supplier populate on read paths
 *
 * Pins the contract that PO list / detail / by-query responses always
 * carry a populated supplier object (`{ _id, name, code }`) instead of a
 * bare ObjectId string. The FE column, detail sheet, and print path all
 * depend on `purchase.supplier.name` resolving without a second round-trip
 * to the suppliers endpoint.
 *
 * Without the `before:getAll/getById/getByQuery` hooks in
 * `purchase-order.repository.ts`, mongoose's `.lean()` returns the raw
 * ref and the FE table cell falls through to printing the ObjectId. This
 * test will fail loudly the day someone removes those hooks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let supplierId: string;
let productId: string;

async function seedProduct(slug: string): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `POPOP-${slug}-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: `Populate Test ${slug}`,
    slug: `populate-test-${slug.toLowerCase()}-${ts}`,
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

function authH() {
  return env.auth.as('admin').headers as Record<string, string>;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'po-populate' });

  // Seed a real supplier via the API so it goes through the controller's
  // validation + code generation path — same shape the FE creates.
  const supplierRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/suppliers`,
    headers: authH(),
    payload: {
      name: `Populate Test Supplier ${Date.now()}`,
      type: 'local',
      phone: '01700000001',
      paymentTerms: 'cash',
    },
  });
  expect(supplierRes.statusCode, supplierRes.body).toBeLessThan(400);
  supplierId = (parse(supplierRes.body) as { _id: string })._id;

  const product = await seedProduct('A');
  productId = product.id;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Purchase Order — supplier populate', () => {
  it('list response populates supplier as { _id, name, code }', async () => {
    // Create a PO with the seeded supplier
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: authH(),
      payload: {
        paymentTerms: 'cash',
        supplierId,
        items: [{ productId, quantity: 2, costPrice: 100 }],
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);

    // List path
    const listRes = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/purchase-orders`,
      headers: authH(),
    });
    expect(listRes.statusCode, listRes.body).toBe(200);
    const body = parse(listRes.body) as { data?: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data!.length).toBeGreaterThan(0);

    const po = body.data![0] as { supplier?: unknown };
    expect(po.supplier).toBeDefined();
    expect(typeof po.supplier).toBe('object');
    const supplier = po.supplier as { _id?: unknown; name?: unknown; code?: unknown };
    expect(supplier._id).toBeDefined();
    expect(typeof supplier.name).toBe('string');
    // `code` is optional — only assert when supplier.code was set on create.
  });

  it('detail (getById) response populates supplier', async () => {
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: authH(),
      payload: {
        paymentTerms: 'cash',
        supplierId,
        items: [{ productId, quantity: 1, costPrice: 50 }],
      },
    });
    const created = parse(createRes.body) as { _id: string };

    const getRes = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/purchase-orders/${created._id}`,
      headers: authH(),
    });
    expect(getRes.statusCode).toBe(200);
    const body = parse(getRes.body) as { supplier?: unknown };
    expect(body.supplier).toBeDefined();
    expect(typeof body.supplier).toBe('object');
    const supplier = body.supplier as { _id?: unknown; name?: unknown };
    expect(String(supplier._id)).toBe(supplierId);
    expect(typeof supplier.name).toBe('string');
  });

  it('returned supplier object is projected (only _id + name + code, no full doc)', async () => {
    // Confirms we don't fan out the entire supplier doc (phone, address,
    // tax fields, etc.) on every PO row — the populate uses a `select`
    // projection. This keeps list payloads small even with many POs.
    const listRes = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/purchase-orders`,
      headers: authH(),
    });
    const body = parse(listRes.body) as { data?: Array<{ supplier?: Record<string, unknown> }> };
    const po = body.data?.find((p) => p.supplier && typeof p.supplier === 'object');
    expect(po).toBeDefined();
    const supplier = po!.supplier as Record<string, unknown>;
    // _id is always returned by mongoose unless explicitly excluded.
    // `name` is the projected field. Anything beyond {_id, name, code} would
    // mean the populate `select` was dropped.
    const allowedKeys = new Set(['_id', 'name', 'code']);
    for (const key of Object.keys(supplier)) {
      expect(allowedKeys.has(key), `supplier leaked field: ${key}`).toBe(true);
    }
  });
});
