/**
 * Transfer approval chain (unified approval framework).
 *
 * Locks the contract for `POST /transfers/:id/action`:
 *
 *   - submit_for_approval attaches a chain to a draft transfer
 *   - decide applies one approver decision via primitives.applyDecision
 *   - approve is gated on isApproved(chain) → 422 APPROVAL_CHAIN_INCOMPLETE
 *     while the chain is pending or rejected
 *   - Transfers without an attached chain still approve directly (SME path)
 *   - Rejection via the chain gives transfer a true reject path (previously
 *     only available via `cancel`)
 *
 * Service-side gate lives in `transferService.approveTransfer`. Test
 * exercises the full HTTP pipeline so the action wiring + service gate are
 * locked together.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { addSecondaryBranch, bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let senderOrgId: string;
let receiverOrgId: string;
let productId: string;
let sku: string;

async function seedProduct(tag: string): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `XAPRV-SKU-${tag}-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: `Approval Chain Widget ${tag}`,
    slug: `xaprv-widget-${tag}-${ts}`,
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

async function seedStockAt(orgId: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, sku, qty, 18000);
}

function setActiveOrgHeader(orgId: string) {
  const headers = { ...env.auth.as('admin').headers } as Record<string, string>;
  headers['x-organization-id'] = orgId;
  return headers;
}

async function createDraftTransfer(qty = 4): Promise<string> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/transfers`,
    headers: setActiveOrgHeader(senderOrgId),
    payload: {
      senderBranchId: senderOrgId,
      receiverBranchId: receiverOrgId,
      documentType: 'delivery_note',
      items: [{ productId, variantSku: sku, quantity: qty }],
    },
  });
  expect(res.statusCode, res.body).toBeLessThan(400);
  return (parse(res.body) as { _id: string })._id;
}

function action(transferId: string, payload: Record<string, unknown>) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/inventory/transfers/${transferId}/action`,
    headers: setActiveOrgHeader(senderOrgId),
    payload,
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'xfr-approval-chain' });
  senderOrgId = env.orgId;

  const product = await seedProduct('chain');
  productId = product.id;
  sku = product.sku;

  receiverOrgId = await addSecondaryBranch(env, {
    slug: 'xfr-approval-chain-recv',
    branchRole: 'branch',
  });

  await seedStockAt(senderOrgId, 200);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Transfer approval chain (unified framework)', () => {
  it('SME path: draft transfer with no chain still approves directly', async () => {
    const transferId = await createDraftTransfer();
    const ok = await action(transferId, { action: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((parse(ok.body) as { status: string }).status).toBe('approved');
  }, 60_000);

  it('sequential 2-step chain: approve is blocked until both steps decide', async () => {
    const transferId = await createDraftTransfer();

    const submitRes = await action(transferId, {
      action: 'submit_for_approval',
      chain: {
        order: 'sequential',
        steps: [
          { id: 'inventory', approvers: [{ id: 'inv-1' }] },
          { id: 'finance', approvers: [{ id: 'cfo-1' }] },
        ],
      },
    });
    expect(submitRes.statusCode, submitRes.body).toBe(200);

    // approve before any decision → 422 APPROVAL_CHAIN_INCOMPLETE
    const earlyApprove = await action(transferId, { action: 'approve' });
    expect(earlyApprove.statusCode).toBe(422);

    // step 1 decides
    const step1 = await action(transferId, {
      action: 'decide',
      stepId: 'inventory',
      approverId: 'inv-1',
      decision: 'approved',
    });
    expect(step1.statusCode).toBe(200);

    // approve still blocked — finance hasn't decided
    const midApprove = await action(transferId, { action: 'approve' });
    expect(midApprove.statusCode).toBe(422);

    // step 2 decides → chain approved
    const step2 = await action(transferId, {
      action: 'decide',
      stepId: 'finance',
      approverId: 'cfo-1',
      decision: 'approved',
    });
    expect(step2.statusCode).toBe(200);
    expect((parse(step2.body) as { approvals: { status: string } }).approvals.status).toBe(
      'approved',
    );

    // approve now succeeds
    const finalApprove = await action(transferId, { action: 'approve' });
    expect(finalApprove.statusCode, finalApprove.body).toBe(200);
    expect((parse(finalApprove.body) as { status: string }).status).toBe('approved');
  }, 90_000);

  it('rejection at any step puts chain in rejected and blocks approve', async () => {
    const transferId = await createDraftTransfer();

    await action(transferId, {
      action: 'submit_for_approval',
      chain: {
        order: 'sequential',
        steps: [
          { id: 'inventory', approvers: [{ id: 'inv-2' }] },
          { id: 'finance', approvers: [{ id: 'cfo-2' }] },
        ],
      },
    });

    const rejected = await action(transferId, {
      action: 'decide',
      stepId: 'inventory',
      approverId: 'inv-2',
      decision: 'rejected',
      note: 'unbalanced sender stock',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((parse(rejected.body) as { approvals: { status: string } }).approvals.status).toBe(
      'rejected',
    );

    const blocked = await action(transferId, { action: 'approve' });
    expect(blocked.statusCode).toBe(422);
  }, 90_000);
});
