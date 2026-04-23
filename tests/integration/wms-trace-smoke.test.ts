/**
 * WMS Traceability HTTP Smoke Test
 *
 * Enterprise-only trace routes — gated behind `FLOW_MODE=enterprise` on the
 * server. Verifies:
 *   GET  /inventory/trace/lot?lotCode=...&skuRef=...    → movement history
 *   GET  /inventory/trace/serial?serialCode=...&skuRef=  → movement history
 *   POST /inventory/trace/recall   { lotCode, skuRef }  → affected locations
 *
 * Flow's trace service keys on `lotCode` (not `lotId`). This suite locks
 * in the HTTP contract after the schema fix.
 *
 * Setup: creates a StockLot directly so we don't depend on the catalog
 * bridge's trackingMode detection. Then fires a receipt with a
 * trackingAssignment pointing at the lot so moves carry the lotId.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
// Loaded in beforeAll after flow is initialized by app boot. `ReturnType`
// unwraps the getter so the variable type reflects the engine instance.
let flow: Awaited<
  ReturnType<typeof import('../../src/resources/inventory/flow/flow-engine.js')>
>['getFlowEngine'] extends () => infer T
  ? T
  : never;
const API = '/api/v1';

beforeAll(async () => {
  // Trace endpoints are enterprise-gated — FLOW_MODE=enterprise also
  // activates Flow's lot/serial trace services. Replaces ~70 lines of
  // inline replSet + mongoose + setupBetterAuthOrg boilerplate.
  env = await bootScenarioApp({ scenario: 'wms-trace', env: { FLOW_MODE: 'enterprise' } });
  server = env.server;

  // Trace routes require `superadmin` role (even tighter than cost/audit).
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );

  // Seed lots/moves/quants directly through mongoose models rather than
  // raw collection inserts — keeps the plugin hooks (trackingAssignments)
  // firing on test seeds.
  const flowMod = await import('../../src/resources/inventory/flow/flow-engine.js');
  flow = flowMod.getFlowEngine();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') {
  return env.auth.getHeaders(role);
}

describe('WMS Trace Smoke — enterprise traceability via HTTP', () => {
  let nodeId: string;
  let storageLocId: string;
  let shippingLocId: string;

  const LOT_SKU = 'TRACE-LOT-SKU';
  const LOT_CODE = 'BATCH-TRACE-001';
  const SERIAL_SKU = 'TRACE-SERIAL-SKU';
  const SERIAL_CODE = 'SN-TRACE-001';

  it('should bootstrap warehouse + two locations (storage + shipping)', async () => {
    const nodesRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/nodes`,
      headers: h(),
    });
    expect(nodesRes.statusCode).toBe(200);
    nodeId = String(JSON.parse(nodesRes.body).data[0]._id);

    // Create a second storage location to model the shipping dock explicitly
    const shipLocRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `TRACE-SHIP-${Date.now()}`,
        name: 'Trace Ship Dock',
        type: 'shipping',
        allowNegativeStock: true,
      },
    });
    expect([200, 201]).toContain(shipLocRes.statusCode);
    shippingLocId = String(JSON.parse(shipLocRes.body).data._id);

    const locsRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
      headers: h(),
    });
    expect(locsRes.statusCode).toBe(200);
    const locs = JSON.parse(locsRes.body).data as Array<{ _id: string; type: string }>;
    const storage =
      locs.find((l) => l.type === 'storage' || l.type === 'stock') ?? locs[0];
    storageLocId = String(storage._id);
    expect(storageLocId).toBeTruthy();
    expect(shippingLocId).toBeTruthy();
  });

  it('should trace a lot through receive → ship movement history', async () => {
    // Seed lot + move + quant via flow's models. Using the engine models
    // (vs raw collection inserts) keeps us aligned with mongoose schema
    // defaults, collection naming, and index setup.
    const orgId = env.orgId;

    const lot = await flow.models.StockLot.create({
      organizationId: orgId,
      skuRef: LOT_SKU,
      trackingType: 'lot',
      lotCode: LOT_CODE,
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86400000),
      status: 'active',
    });
    const lotId = String(lot._id);

    const moveGroup = await flow.models.StockMoveGroup.create({
      organizationId: orgId,
      groupType: 'receipt',
      documentNumber: `RCV-TRACE-${Date.now()}`,
      status: 'done',
    });

    await flow.models.StockMove.create({
      organizationId: orgId,
      moveGroupId: moveGroup._id,
      operationType: 'receipt',
      skuRef: LOT_SKU,
      sourceLocationId: 'vendor',
      destinationLocationId: storageLocId,
      quantityPlanned: 30,
      quantityDone: 30,
      status: 'done',
      executedAt: new Date(),
      trackingAssignments: [
        { trackingMode: 'lot', lotId, lotCode: LOT_CODE, quantity: 30 },
      ],
    });

    await flow.models.StockQuant.create({
      organizationId: orgId,
      skuRef: LOT_SKU,
      locationId: storageLocId,
      lotId,
      stockStatus: 'sellable',
      quantityOnHand: 30,
      quantityReserved: 0,
      quantityAvailable: 30,
      quantityIncoming: 0,
      quantityOutgoing: 0,
      inDate: new Date(),
    });

    // Now call the trace endpoint
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/trace/lot?lotCode=${encodeURIComponent(LOT_CODE)}&skuRef=${encodeURIComponent(LOT_SKU)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.lot.lotCode).toBe(LOT_CODE);
    expect(body.data.lot.skuRef).toBe(LOT_SKU);
    expect(body.data.totalQuantity).toBe(30);
    expect(body.data.currentLocations).toHaveLength(1);
    expect(String(body.data.currentLocations[0].locationId)).toBe(storageLocId);
    expect(body.data.currentLocations[0].quantity).toBe(30);
    expect(body.data.movementHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('should return 404 for a lot code that does not exist', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/trace/lot?lotCode=DOES-NOT-EXIST&skuRef=${encodeURIComponent(LOT_SKU)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/DOES-NOT-EXIST/);
  });

  it('should trace a serial-tracked unit', async () => {
    const orgId = env.orgId;

    const lot = await flow.models.StockLot.create({
      organizationId: orgId,
      skuRef: SERIAL_SKU,
      trackingType: 'serial',
      serialCode: SERIAL_CODE,
      receivedAt: new Date(),
      status: 'active',
    });
    const lotId = String(lot._id);

    await flow.models.StockQuant.create({
      organizationId: orgId,
      skuRef: SERIAL_SKU,
      locationId: storageLocId,
      lotId,
      stockStatus: 'sellable',
      quantityOnHand: 1,
      quantityReserved: 0,
      quantityAvailable: 1,
      quantityIncoming: 0,
      quantityOutgoing: 0,
      inDate: new Date(),
    });

    const moveGroup = await flow.models.StockMoveGroup.create({
      organizationId: orgId,
      groupType: 'receipt',
      documentNumber: `RCV-SERIAL-${Date.now()}`,
      status: 'done',
    });

    await flow.models.StockMove.create({
      organizationId: orgId,
      moveGroupId: moveGroup._id,
      operationType: 'receipt',
      skuRef: SERIAL_SKU,
      sourceLocationId: 'vendor',
      destinationLocationId: storageLocId,
      quantityPlanned: 1,
      quantityDone: 1,
      status: 'done',
      executedAt: new Date(),
      trackingAssignments: [
        { trackingMode: 'serial', lotId, serialCode: SERIAL_CODE, quantity: 1 },
      ],
    });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/trace/serial?serialCode=${encodeURIComponent(SERIAL_CODE)}&skuRef=${encodeURIComponent(SERIAL_SKU)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.lot.serialCode).toBe(SERIAL_CODE);
    expect(body.data.lot.trackingType).toBe('serial');
    expect(body.data.totalQuantity).toBe(1);
  });

  it('should run a recall analysis for an existing lot', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/trace/recall`,
      headers: h(),
      payload: { lotCode: LOT_CODE, skuRef: LOT_SKU },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.lot.lotCode).toBe(LOT_CODE);
    expect(body.data.totalInWarehouse).toBe(30);
    expect(body.data.totalShipped).toBe(0); // nothing shipped yet
    expect(body.data.affectedLocations).toHaveLength(1);
    expect(body.data.shippedMoves).toHaveLength(0);
  });

  it('should reject unauthenticated trace requests', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/trace/lot?lotCode=${encodeURIComponent(LOT_CODE)}&skuRef=${encodeURIComponent(LOT_SKU)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('should reject trace queries missing required parameters', async () => {
    // Missing skuRef
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/trace/lot?lotCode=${encodeURIComponent(LOT_CODE)}`,
      headers: h(),
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});
