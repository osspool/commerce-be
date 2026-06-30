/**
 * Branch off-boarding endpoint — HQ admin purges a closing branch's WMS data.
 *
 * Pins the full path: HTTP POST → requireHeadOfficeAdmin gate → flow.purgeBranch
 * → every org-scoped flow collection for the target branch is emptied, the
 * append-only ledger is retained, and sibling branches (HO) are untouched.
 */

import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSecondaryBranch, bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let hoId: string;
let targetId: string;

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const url = (branchId: string) => `/api/v1/inventory/admin/branches/${branchId}/purge`;

async function countFor(model: string, orgId: string): Promise<number> {
  const flow = (await import('#resources/inventory/flow/flow-engine.js')).getFlowEngine();
  return (flow.models as Record<string, { countDocuments: (f: unknown) => Promise<number> }>)[model].countDocuments({
    organizationId: oid(orgId),
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'branch-offboard', env: { FLOW_MODE: 'standard' } });
  server = env.server;
  hoId = env.orgId; // bootScenarioApp tags HO as head_office + admin role.
  targetId = await addSecondaryBranch(env, { slug: 'offboard-target', branchRole: 'branch' });

  // Seed real WMS data into the target branch (quants, moves, groups, POs)
  // on top of its bootstrapped node + locations.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const flow = getFlowEngine();
  const tctx = buildFlowContext(targetId, 'offboard-seed');
  const node = await flow.models.InventoryNode.findOne({ organizationId: oid(targetId) }).lean();
  const loc = await flow.models.Location.findOne({
    organizationId: oid(targetId),
    type: 'storage',
  }).lean();
  const po = await flow.services.procurement.create(
    {
      vendorRef: 'V-OFFB',
      destinationNodeId: String((node as { _id: unknown })._id),
      destinationLocationId: String((loc as { _id: unknown })._id),
      items: [{ skuRef: 'OFFB-SKU', quantity: 10, unitCost: 2 }],
    },
    tctx,
  );
  await flow.services.procurement.approve(po._id, tctx);
  await flow.services.procurement.receive(po._id, { lines: [{ skuRef: 'OFFB-SKU', quantityReceived: 10 }] }, tctx);
}, 240_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('branch off-boarding endpoint', () => {
  it('rejects a confirmation-token mismatch (400)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: url(targetId),
      headers: env.auth.as('admin').headers,
      payload: { confirm: 'WRONG' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to off-board the head-office branch (400)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: url(hoId),
      headers: env.auth.as('admin').headers,
      payload: { confirm: hoId },
    });
    expect(res.statusCode).toBe(400);
    // HO must remain fully intact after the refusal.
    expect(await countFor('Location', hoId)).toBeGreaterThan(0);
  });

  it('purges the target branch end-to-end, leaves HO intact', async () => {
    // Pre: target holds real stock; HO holds its own.
    expect(await countFor('StockQuant', targetId)).toBeGreaterThan(0);
    expect(await countFor('Location', targetId)).toBeGreaterThan(0);
    const hoLocsBefore = await countFor('Location', hoId);
    expect(hoLocsBefore).toBeGreaterThan(0);

    const res = await server.inject({
      method: 'POST',
      url: url(targetId),
      headers: env.auth.as('admin').headers,
      payload: { confirm: targetId, batchSize: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      organizationId: string;
      totalProcessed: number;
      byCollection: Record<string, number>;
      skipped: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.organizationId).toBe(targetId);
    expect(body.totalProcessed).toBeGreaterThan(0);
    expect(body.byCollection.quant).toBeGreaterThan(0);
    expect(body.skipped).toContain('stockEvent'); // append-only ledger retained

    // Target branch is wiped across collections…
    expect(await countFor('StockQuant', targetId)).toBe(0);
    expect(await countFor('StockMove', targetId)).toBe(0);
    expect(await countFor('ProcurementOrder', targetId)).toBe(0);
    expect(await countFor('Location', targetId)).toBe(0);
    expect(await countFor('InventoryNode', targetId)).toBe(0);

    // …and HO is untouched.
    expect(await countFor('Location', hoId)).toBe(hoLocsBefore);
  });
});
