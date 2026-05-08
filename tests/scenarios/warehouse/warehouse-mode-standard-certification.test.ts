/**
 * Warehouse Mode Certification — Standard
 *
 * Exercises the mode-gating policy for `FLOW_MODE=standard`:
 *   - Single warehouse node allowed (second POST → 400)
 *   - Location design APIs (create, layout) available
 *   - Enterprise-only reports (availability, health) → 403
 *
 * Uses MongoMemoryReplSet via `bootScenarioApp` because locations are
 * created through Flow services wrapped in `unitOfWork.withTransaction`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let server: FastifyInstance;
let nodeId: string;

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'std-wh',
    env: { FLOW_MODE: 'standard' },
    extraOrgUpdate: { code: 'STD', branchType: 'warehouse' },
  });
  server = env.server;

  // Mode-gating routes (nodes, reports) require superadmin; bootScenarioApp
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
    headers: env.auth.as('admin').headers,
    ...(payload ? { payload } : {}),
  });
}

describe('Warehouse Mode Certification: Standard', () => {
  it('supports default node plus location design APIs', async () => {
    const nodesRes = await inject('GET', '/inventory/nodes');
    expect(nodesRes.statusCode).toBe(200);
    const nodesBody = parse(nodesRes.body);
    expect(Array.isArray(nodesBody)).toBe(true);
    expect(nodesBody.length).toBe(1);
    nodeId = String(nodesBody[0]._id);

    const locationCode = `A-${Date.now()}`;
    const createLocRes = await inject('POST', '/inventory/locations', {
      nodeId,
      code: locationCode,
      name: 'Rack A Bin 01',
      type: 'storage',
      allowReservations: true,
      allowNegativeStock: false,
      coordinates: { zone: 'A', aisle: 1, bay: 1, level: 1, bin: '01' },
    });
    expect(createLocRes.statusCode).toBe(201);
    expect(parse(createLocRes.body)?.code).toBe(locationCode);

    const layoutRes = await inject('GET', `/inventory/locations/layout?nodeId=${nodeId}`);
    expect(layoutRes.statusCode).toBe(200);
    const layoutBody = parse(layoutRes.body);
    expect(layoutBody?.totalLocations).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(layoutBody?.zones)).toBe(true);
  });

  it('rejects a second warehouse node in standard mode', async () => {
    const createNodeRes = await inject('POST', '/inventory/nodes', {
      code: 'STD-2',
      name: 'Second Warehouse',
      type: 'warehouse',
      isDefault: false,
    });
    expect(createNodeRes.statusCode).toBe(400);
    expect(parse(createNodeRes.body)?.message).toContain('Only 1 warehouse allowed');
  });

  it('rejects enterprise reports in standard mode', async () => {
    const availabilityRes = await inject('GET', '/inventory/reports/availability');
    expect(availabilityRes.statusCode).toBe(403);

    const healthRes = await inject('GET', '/inventory/reports/health');
    expect(healthRes.statusCode).toBe(403);
  });
});
