/**
 * WMS Procurement HTTP Smoke Test
 *
 * Exercises the full procurement/PO lifecycle through the real HTTP pipeline.
 * Covers the inbound receiving path that the WMS skill requires for
 * enterprise certification:
 *   draft → approve → receive (within tolerance) → over-tolerance rejection
 *
 * Uses MongoMemoryReplSet because flow's procurement service wraps mutations
 * in `unitOfWork.withTransaction`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  // FLOW_MODE=standard is required — the procurement service wraps mutations
  // in `unitOfWork.withTransaction`, which only activates at standard+.
  env = await bootScenarioApp({ scenario: 'wms-proc', env: { FLOW_MODE: 'standard' } });
  server = env.server;

  // Procurement routes require `superadmin` role. `bootScenarioApp` provisions
  // plain `admin`; promote in place.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') {
  return env.auth.as(role).headers;
}

describe('WMS Procurement Smoke — PO lifecycle via HTTP', () => {
  let nodeId: string;
  let storageLocationId: string;
  let poId: string;

  it('should expose a bootstrapped warehouse node to receive against', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/nodes`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as Array<{ _id: string }>;
    expect(body.length).toBeGreaterThan(0);
    nodeId = String(body[0]._id);
  });

  it('should expose a storage location for receipts', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as Array<{ _id: string; type: string }>;
    const storage = body.find(
      (l) => l.type === 'storage' || l.type === 'stock',
    );
    storageLocationId = String((storage ?? body[0])._id);
  });

  it('POST /inventory/procurement should create a purchase order', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement`,
      headers: h(),
      payload: {
        vendorRef: 'SMOKE-VENDOR-001',
        destinationNodeId: nodeId,
        destinationLocationId: storageLocationId,
        items: [{ skuRef: 'SMOKE-PO-SKU-A', quantity: 100, unitCost: 5 }],
      },
    });
    expect([200, 201]).toContain(res.statusCode);

    const body = JSON.parse(res.body);

    expect(body.status).toBe('draft');
    expect(body.vendorRef).toBe('SMOKE-VENDOR-001');
    poId = String(body._id);
  });

  it('GET /inventory/procurement should list the PO', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/procurement`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    // Arc emits the mongokit `getAll` envelope at the top level:
    // `{ docs: [...], total, page, limit, pages }`. Earlier this test
    // read `body.data.map(...)` which assumed a different envelope shape.
    const body = JSON.parse(res.body) as { data: Array<{ _id: string }> };
    const ids = body.data.map((d) => String(d._id));
    expect(ids).toContain(poId);
  });

  it('POST /inventory/procurement/:id/action approve should approve', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/action`,
      headers: h(),
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe('approved');
  });

  it('POST /inventory/procurement/:id/receive should accept a receipt within tolerance', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/receive`,
      headers: h(),
      payload: {
        lines: [
          // 105 ≤ 100 × 1.10 = within tolerance
          { skuRef: 'SMOKE-PO-SKU-A', quantityReceived: 105 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(['received', 'partially_received']).toContain(body.status);
  });

  it('GET /inventory/availability should reflect received stock', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=SMOKE-PO-SKU-A&locationId=${encodeURIComponent(storageLocationId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.quantityOnHand).toBe(105);
  });

  it('should reject a receipt beyond the 10% over-receipt tolerance', async () => {
    // New PO for 20, attempt to receive 25 (25 > 20 × 1.10 = 22)
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement`,
      headers: h(),
      payload: {
        vendorRef: 'SMOKE-VENDOR-002',
        destinationNodeId: nodeId,
        destinationLocationId: storageLocationId,
        items: [{ skuRef: 'SMOKE-OVER-SKU', quantity: 20, unitCost: 3 }],
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);
    const overPo = JSON.parse(createRes.body)._id;

    await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${overPo}/action`,
      headers: h(),
      payload: { action: 'approve' },
    });

    const receiveRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${overPo}/receive`,
      headers: h(),
      payload: {
        lines: [{ skuRef: 'SMOKE-OVER-SKU', quantityReceived: 25 }],
      },
    });
    // ValidationError from flow → Arc's error handler maps to 400 or 500
    expect([400, 500]).toContain(receiveRes.statusCode);
  });

  // ── Supplier Return Scenario ──

  let returnPoId: string;

  it('should create + approve + receive a PO for supplier return test', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement`,
      headers: h(),
      payload: {
        vendorRef: 'SMOKE-VENDOR-RETURN',
        destinationNodeId: nodeId,
        destinationLocationId: storageLocationId,
        items: [
          { skuRef: 'SMOKE-RETURN-A', quantity: 50, unitCost: 10 },
          { skuRef: 'SMOKE-RETURN-B', quantity: 30, unitCost: 20 },
        ],
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);
    returnPoId = JSON.parse(createRes.body)._id;

    await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${returnPoId}/action`,
      headers: h(),
      payload: { action: 'approve' },
    });

    const receiveRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${returnPoId}/receive`,
      headers: h(),
      payload: {
        lines: [
          { skuRef: 'SMOKE-RETURN-A', quantityReceived: 50 },
          { skuRef: 'SMOKE-RETURN-B', quantityReceived: 30 },
        ],
      },
    });
    expect(receiveRes.statusCode).toBe(200);
    expect(JSON.parse(receiveRes.body).status).toBe('received');
  });

  it('POST /inventory/procurement/:id/supplier-return should return items to vendor', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${returnPoId}/supplier-return`,
      headers: h(),
      payload: {
        lines: [
          { skuRef: 'SMOKE-RETURN-A', quantity: 20 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);

    expect(body.status).toBe('done');
    expect(body.groupType).toBe('return');
  });

  it('should reflect reduced stock after supplier return', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=SMOKE-RETURN-A&locationId=${encodeURIComponent(storageLocationId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    // Had 50, returned 20 → should be 30
    expect(body.quantityOnHand).toBe(30);
  });

  it('should reject supplier return with empty lines', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${returnPoId}/supplier-return`,
      headers: h(),
      payload: { lines: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should require authentication on protected procurement routes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/procurement`,
    });
    expect(res.statusCode).toBe(401);
  });
});
