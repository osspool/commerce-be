/**
 * WMS Cost Valuation HTTP Smoke Test
 *
 * Exercises the cost-layer / valuation reporting routes end-to-end:
 *   POST /inventory/procurement          → creates PO
 *   POST /inventory/procurement/:id/action approve
 *   POST /inventory/procurement/:id/receive (qty, unitCost)
 *   GET  /inventory/cost/layers           → lists FIFO/FEFO layers
 *   GET  /inventory/cost/valuation        → aggregated value per SKU/location
 *
 * A receipt posted through procurement.receive should create a cost layer
 * whose remaining quantity matches what landed in the quant and whose
 * unitCost matches the PO line. This proves that the cost ledger is in
 * sync with the physical stock ledger.
 *
 * Uses MongoMemoryReplSet because flow services wrap mutations in
 * `unitOfWork.withTransaction`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  // Shared scenario-setup helper — replaces ~60 lines of inline replSet +
  // mongoose.connect + seedPlatformConfig + setupBetterAuthOrg boilerplate.
  // FLOW_MODE=standard is required because the procurement receive path
  // wraps writes in `unitOfWork.withTransaction`.
  env = await bootScenarioApp({ scenario: 'wms-cost', env: { FLOW_MODE: 'standard' } });
  server = env.server;

  // Cost / valuation reports require `superadmin` role. `bootScenarioApp`
  // provisions plain `admin`; promote in place.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') {
  return env.auth.getHeaders(role);
}

describe('WMS Cost Valuation Smoke — cost ledger via HTTP', () => {
  let nodeId: string;
  let storageLocId: string;

  it('should expose bootstrapped warehouse + storage location', async () => {
    const nodesRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/nodes`,
      headers: h(),
    });
    expect(nodesRes.statusCode).toBe(200);
    nodeId = String(JSON.parse(nodesRes.body).data[0]._id);

    const locsRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
      headers: h(),
    });
    expect(locsRes.statusCode).toBe(200);
    const locs = JSON.parse(locsRes.body).data as Array<{ _id: string; type: string }>;
    const storage = locs.find((l) => l.type === 'storage' || l.type === 'stock') ?? locs[0];
    storageLocId = String(storage._id);
  });

  it('should create a cost layer when a PO is received at unit cost', async () => {
    // 1. Create PO for 50 units @ $12 each → expected ledger value 600
    const poRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement`,
      headers: h(),
      payload: {
        vendorRef: 'COST-VENDOR-001',
        destinationNodeId: nodeId,
        destinationLocationId: storageLocId,
        items: [{ skuRef: 'COST-SMOKE-A', quantity: 50, unitCost: 12 }],
      },
    });
    expect([200, 201]).toContain(poRes.statusCode);
    const poId = JSON.parse(poRes.body).data._id;

    // 2. Approve
    const approveRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/action`,
      headers: h(),
      payload: { action: 'approve' },
    });
    expect(approveRes.statusCode).toBe(200);

    // 3. Receive full quantity
    const recvRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/receive`,
      headers: h(),
      payload: {
        lines: [{ skuRef: 'COST-SMOKE-A', quantityReceived: 50 }],
      },
    });
    expect(recvRes.statusCode).toBe(200);

    // 4. GET /inventory/cost/layers MUST return the auto-emitted cost layer.
    // After the flow fix to procurement.executeReceive, every receipt with a
    // positive unitCost is guaranteed to write a cost layer in the same
    // transaction. Defensive `if (length > 0)` guards are no longer correct.
    const layersRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/cost/layers?skuRef=COST-SMOKE-A&locationId=${encodeURIComponent(storageLocId)}`,
      headers: h(),
    });
    expect(layersRes.statusCode).toBe(200);

    const layersBody = JSON.parse(layersRes.body);
    expect(layersBody.success).toBe(true);
    expect(layersBody.data.length).toBeGreaterThan(0);

    const layer = layersBody.data[0];
    expect(layer.skuRef).toBe('COST-SMOKE-A');
    expect(layer.unitCost).toBe(12);
    expect(layer.remainingQty).toBe(50);
  });

  it('should return non-zero valuation totals from GET /inventory/cost/valuation', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/cost/valuation?skuRef=COST-SMOKE-A&locationId=${encodeURIComponent(storageLocId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    // Strict: the previous test just received 50 units @ $12, so the
    // valuation endpoint must return exactly that (no partial consumes
    // have happened since).
    expect(body.data.totalQuantity).toBe(50);
    expect(body.data.totalValue).toBe(600);
    expect(body.data.averageUnitCost).toBe(12);
    expect(body.data.layerCount).toBe(1);
  });

  it('should return layers for a SKU that has no cost history as empty (not 404)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/cost/layers?skuRef=NONEXISTENT-SKU-XYZ&locationId=${encodeURIComponent(storageLocId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('should require authentication on cost routes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/cost/valuation?skuRef=ANY`,
    });
    expect(res.statusCode).toBe(401);
  });
});
