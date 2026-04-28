/**
 * Procurement multi-level approval chain (T2.1).
 *
 * Locks the composition contract:
 *   - submit_for_approval attaches a chain to a draft PO
 *   - decide applies one approver decision via primitives.applyDecision
 *   - approve is gated on isApproved(chain) → 422 APPROVAL_CHAIN_INCOMPLETE
 *     while the chain is pending or rejected
 *   - POs without an attached chain still approve directly (SME path)
 *
 * Kernel gate lives in `@classytic/flow` ProcurementService.approve().
 * Test exercises the full HTTP pipeline so we lock be-prod's action wiring,
 * not just the primitive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'proc-approval',
    env: { FLOW_MODE: 'standard' },
  });
  server = env.server;

  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h() {
  return env.auth.as('admin').headers;
}

async function createDraftPO(vendorRef: string, sku: string, qty = 10) {
  const nodesRes = await server.inject({ method: 'GET', url: `${API}/inventory/nodes`, headers: h() });
  const nodeId = JSON.parse(nodesRes.body).data[0]._id;

  const locsRes = await server.inject({
    method: 'GET',
    url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
    headers: h(),
  });
  const locs = JSON.parse(locsRes.body).data as Array<{ _id: string; type: string }>;
  const storage = locs.find((l) => l.type === 'storage' || l.type === 'stock') ?? locs[0];

  const createRes = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement`,
    headers: h(),
    payload: {
      vendorRef,
      destinationNodeId: String(nodeId),
      destinationLocationId: String(storage!._id),
      items: [{ skuRef: sku, quantity: qty, unitCost: 1 }],
    },
  });
  expect([200, 201]).toContain(createRes.statusCode);
  return JSON.parse(createRes.body).data._id as string;
}

function action(poId: string, payload: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${poId}/action`,
    headers: h(),
    payload,
  });
}

describe('Procurement approval chain (T2.1)', () => {
  it('sequential 2-step: finance cannot finalize approve until sales decides', async () => {
    const poId = await createDraftPO('VEN-SEQ', 'CHAIN-SKU-SEQ');

    const submitRes = await action(poId, {
      action: 'submit_for_approval',
      chain: {
        order: 'sequential',
        steps: [
          { id: 'sales', approvers: [{ id: 'rep-1' }] },
          { id: 'finance', approvers: [{ id: 'cfo-1' }] },
        ],
      },
    });
    expect(submitRes.statusCode).toBe(200);

    // approve before any decision → 422
    const earlyApprove = await action(poId, { action: 'approve' });
    expect(earlyApprove.statusCode).toBe(422);
    expect(JSON.parse(earlyApprove.body).code).toBe('APPROVAL_CHAIN_INCOMPLETE');

    // finance trying to act first should be rejected by primitive (sequential)
    const earlyFinance = await action(poId, {
      action: 'decide',
      stepId: 'finance',
      approverId: 'cfo-1',
      decision: 'approved',
    });
    expect(earlyFinance.statusCode).toBe(422);

    // sales approves
    const salesOk = await action(poId, {
      action: 'decide',
      stepId: 'sales',
      approverId: 'rep-1',
      decision: 'approved',
    });
    expect(salesOk.statusCode).toBe(200);

    // approve still blocked — finance hasn't decided
    const midApprove = await action(poId, { action: 'approve' });
    expect(midApprove.statusCode).toBe(422);

    // finance approves → chain approved
    const financeOk = await action(poId, {
      action: 'decide',
      stepId: 'finance',
      approverId: 'cfo-1',
      decision: 'approved',
    });
    expect(financeOk.statusCode).toBe(200);
    expect(JSON.parse(financeOk.body).data.approvalChain.status).toBe('approved');

    // approve now succeeds
    const finalApprove = await action(poId, { action: 'approve' });
    expect(finalApprove.statusCode).toBe(200);
    expect(JSON.parse(finalApprove.body).data.status).toBe('approved');
  });

  it('parallel chain with quorum (2-of-3) blocks until quorum is reached', async () => {
    const poId = await createDraftPO('VEN-PAR', 'CHAIN-SKU-PAR');

    await action(poId, {
      action: 'submit_for_approval',
      chain: {
        order: 'parallel',
        steps: [
          {
            id: 'directors',
            approvers: [{ id: 'dir-1' }, { id: 'dir-2' }, { id: 'dir-3' }],
            requiredApprovals: 2,
          },
        ],
      },
    });

    // 1 of 3 — still pending
    await action(poId, {
      action: 'decide',
      stepId: 'directors',
      approverId: 'dir-1',
      decision: 'approved',
    });
    const oneOnly = await action(poId, { action: 'approve' });
    expect(oneOnly.statusCode).toBe(422);

    // 2 of 3 — quorum reached
    const second = await action(poId, {
      action: 'decide',
      stepId: 'directors',
      approverId: 'dir-2',
      decision: 'approved',
    });
    expect(JSON.parse(second.body).data.approvalChain.status).toBe('approved');

    const ok = await action(poId, { action: 'approve' });
    expect(ok.statusCode).toBe(200);
  });

  it('rejection at any step puts chain in rejected and blocks approve', async () => {
    const poId = await createDraftPO('VEN-REJ', 'CHAIN-SKU-REJ');

    await action(poId, {
      action: 'submit_for_approval',
      chain: {
        order: 'sequential',
        steps: [
          { id: 'sales', approvers: [{ id: 'rep-2' }] },
          { id: 'finance', approvers: [{ id: 'cfo-2' }] },
        ],
      },
    });

    const rejected = await action(poId, {
      action: 'decide',
      stepId: 'sales',
      approverId: 'rep-2',
      decision: 'rejected',
      note: 'budget unavailable',
    });
    expect(JSON.parse(rejected.body).data.approvalChain.status).toBe('rejected');

    const blocked = await action(poId, { action: 'approve' });
    expect(blocked.statusCode).toBe(422);
    expect(JSON.parse(blocked.body).code).toBe('APPROVAL_CHAIN_INCOMPLETE');
  });

  it('PO without an attached chain still approves directly (SME path)', async () => {
    const poId = await createDraftPO('VEN-SME', 'CHAIN-SKU-SME');

    const ok = await action(poId, { action: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).data.status).toBe('approved');
  });
});
