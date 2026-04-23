/**
 * Warehouse Mode Certification — Enterprise
 *
 * Exercises the mode-gating policy for `FLOW_MODE=enterprise`:
 *   - Multiple warehouse nodes allowed in one branch
 *   - Location design works on any (non-default) warehouse
 *   - Enterprise-only reports (availability, health, aging) → 200
 *
 * Uses MongoMemoryReplSet via `bootScenarioApp` because Flow mutations
 * run inside `unitOfWork.withTransaction`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let server: FastifyInstance;
let nodeIds: string[] = [];

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'ent-wh',
    env: { FLOW_MODE: 'enterprise' },
    extraOrgUpdate: { code: 'ENT', branchType: 'warehouse' },
  });
  server = env.server;

  // Node/report mode-gating routes require superadmin; bootScenarioApp
  // provisions plain admin — promote in place.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function inject(method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: `${API}${url}`,
    headers: env.auth.getHeaders('admin'),
    ...(payload ? { payload } : {}),
  });
}

describe('Warehouse Mode Certification: Enterprise', () => {
  it('supports multiple warehouse nodes in one branch', async () => {
    const nodesRes = await inject('GET', '/inventory/nodes');
    expect(nodesRes.statusCode).toBe(200);
    const initialNodes = parse(nodesRes.body)?.data ?? [];
    expect(initialNodes.length).toBeGreaterThanOrEqual(1);

    const secondNodeRes = await inject('POST', '/inventory/nodes', {
      code: 'ENT-2',
      name: 'Overflow Warehouse',
      type: 'warehouse',
      isDefault: false,
    });
    expect(secondNodeRes.statusCode).toBe(201);

    const thirdNodeRes = await inject('POST', '/inventory/nodes', {
      code: 'ENT-3',
      name: 'Returns Warehouse',
      type: 'warehouse',
      isDefault: false,
    });
    expect(thirdNodeRes.statusCode).toBe(201);

    const finalNodesRes = await inject('GET', '/inventory/nodes');
    expect(finalNodesRes.statusCode).toBe(200);
    const finalNodes = parse(finalNodesRes.body)?.data ?? [];
    expect(finalNodes.length).toBeGreaterThanOrEqual(3);
    nodeIds = finalNodes.map((node: { _id: string }) => String(node._id));
  });

  it('supports location design on non-default warehouses', async () => {
    const targetNodeId = nodeIds.find((id) => typeof id === 'string');
    expect(targetNodeId).toBeTruthy();

    const createLocRes = await inject('POST', '/inventory/locations', {
      nodeId: targetNodeId,
      code: 'B-02-01',
      name: 'Zone B Rack 02 Bin 01',
      type: 'storage',
      allowReservations: true,
      allowNegativeStock: false,
      coordinates: { zone: 'B', aisle: 2, bay: 1, level: 1, bin: '01' },
    });
    expect(createLocRes.statusCode).toBe(201);

    const listLocRes = await inject('GET', `/inventory/locations?nodeId=${targetNodeId}`);
    expect(listLocRes.statusCode).toBe(200);
    const listLocBody = parse(listLocRes.body);
    expect(Array.isArray(listLocBody?.data)).toBe(true);
    expect(listLocBody.data.some((location: { code: string }) => location.code === 'B-02-01')).toBe(true);
  });

  it('exposes enterprise reports instead of mode-gating them', async () => {
    const availabilityRes = await inject('GET', '/inventory/reports/availability');
    expect(availabilityRes.statusCode).toBe(200);
    expect(parse(availabilityRes.body)?.success).toBe(true);

    const healthRes = await inject('GET', '/inventory/reports/health');
    expect(healthRes.statusCode).toBe(200);
    expect(parse(healthRes.body)?.success).toBe(true);

    const agingRes = await inject('GET', '/inventory/reports/aging');
    expect(agingRes.statusCode).toBe(200);
    expect(parse(agingRes.body)?.success).toBe(true);
  });
});
