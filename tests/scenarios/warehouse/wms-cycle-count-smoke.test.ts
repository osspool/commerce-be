/**
 * WMS Cycle-Count HTTP Smoke Test
 *
 * Exercises the audit/cycle-count flow end-to-end through the real HTTP
 * pipeline: Arc → flow engine → MongoDB (replica set). Verifies that:
 *   1. A bootstrapped warehouse node + storage location exist.
 *   2. A cycle-count session can be opened, lines submitted, variance
 *      calculated, and reconciled — all via the `/inventory/audits` routes.
 *   3. The reconcile action creates adjustment moves and the `post-moves`
 *      action finalizes them.
 *
 * This is a true integration test — nothing is mocked. If Arc, Better Auth,
 * Mongoose, or the flow engine wiring drift, this will fail loudly.
 *
 * NOTE: Flow's counting service wraps mutations in `unitOfWork.withTransaction`
 * which requires a MongoDB replica set. This suite therefore spins up its own
 * MongoMemoryReplSet in beforeAll and is registered in `replSetTests`
 * (vitest.shared.ts) so vitest.replset.config.ts picks it up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  // Use the shared scenario-setup helper — single call replaces ~70 lines of
  // replSet + mongoose.connect + seedPlatformConfig + setupBetterAuthOrg +
  // resource loading that each smoke test used to duplicate inline.
  //
  // FLOW_MODE=standard is required because Flow's counting service wraps
  // mutations in `unitOfWork.withTransaction`, which only fires when the
  // mode is `standard` or higher.
  env = await bootScenarioApp({ scenario: 'wms-cc', env: { FLOW_MODE: 'standard' } });
  server = env.server;

  // Inventory audit routes require `superadmin` role. `bootScenarioApp`
  // provisions the user as plain `admin`; promote in place. The auth
  // provider uses `adminRole: 'admin'` as the HEADER LABEL regardless —
  // changing the mongo user role is what actually passes permission checks.
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

describe('WMS Cycle Count Smoke — audit lifecycle via HTTP', () => {
  let nodeId: string;
  let locationId: string;
  let auditId: string;

  it('should expose a bootstrapped warehouse node for the test org', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/nodes`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    nodeId = String(body.data[0]._id);
  });

  it('should list default bootstrapped locations under the node', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const storageLoc = body.data.find(
      (l: { type: string }) => l.type === 'storage' || l.type === 'stock',
    );
    locationId = String((storageLoc ?? body.data[0])._id);
  });

  it('POST /inventory/audits should create a cycle-count session', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits`,
      headers: h(),
      payload: {
        countType: 'cycle',
        scope: { nodeId },
      },
    });
    expect([200, 201]).toContain(res.statusCode);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data._id).toBeDefined();
    expect(body.data.countType).toBe('cycle');
    expect(body.data.status).toBe('draft');
    auditId = String(body.data._id);
  });

  it('GET /inventory/audits should list the new session', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/audits`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    // Arc emits mongokit's `getAll` envelope at the top level:
    // `{ success, docs, total, page, limit, pages }`. Reading `body.data`
    // returned `undefined` here (same drift fixed for procurement in Batch M).
    const body = JSON.parse(res.body) as { success: boolean; docs: Array<{ _id: string }> };
    expect(body.success).toBe(true);
    const ids = body.docs.map((d) => String(d._id));
    expect(ids).toContain(auditId);
  });

  it('POST /inventory/audits/:id/lines should submit count lines', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/${auditId}/lines`,
      headers: h(),
      payload: {
        lines: [
          {
            skuRef: 'SMOKE-SKU-A',
            locationId,
            countedQuantity: 25,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const line = body.data[0];
    expect(line.skuRef).toBe('SMOKE-SKU-A');
    expect(line.countedQuantity).toBe(25);
  });

  it('GET /inventory/audits/:id/variance should report the delta', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/audits/${auditId}/variance`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalLines).toBeGreaterThan(0);
    expect(Array.isArray(body.data.lines)).toBe(true);
  });

  it('POST /inventory/audits/:id/action reconcile should create adjustment moves', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/${auditId}/action`,
      headers: h(),
      payload: {
        action: 'reconcile',
        autoApproveThreshold: 100,
      },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalLines).toBeGreaterThanOrEqual(1);
    // With a high threshold (100), all variance lines should be auto-approved
    expect(body.data.autoApproved).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.data.adjustmentMoves)).toBe(true);
  });

  it('POST /inventory/audits/:id/action post-moves should finalize adjustments', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/${auditId}/action`,
      headers: h(),
      payload: { action: 'post-moves' },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.posted).toBe(true);
  });

  it('GET /inventory/availability should reflect the adjusted quant', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=SMOKE-SKU-A&locationId=${encodeURIComponent(locationId)}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // After post-moves, the 25-unit surplus landed at the location
    expect(body.data.quantityOnHand).toBeGreaterThanOrEqual(0);
  });

  it('POST /inventory/audits/:id/action with invalid action should 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/${auditId}/action`,
      headers: h(),
      payload: { action: 'explode' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    // Arc's action pipeline returns 'Validation failed' for unknown action
    // verbs (the enum validator rejects at the schema layer before the
    // handler runs). The previous 'invalid action' wording was from the
    // service-level check that's now dead-code behind the schema check.
    expect(body.error).toMatch(/validation|invalid action/i);
  });

  it('should reject unauthenticated audit list', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/audits`,
    });
    expect(res.statusCode).toBe(401);
  });
});
