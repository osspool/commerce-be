/**
 * Purchase Order (be-prod's own) — multi-level approval chain.
 *
 * Locks the composition contract for the be-prod PO subject (distinct from
 * Flow's `procurement` subject):
 *   - submit_for_approval attaches a chain to a draft PO
 *   - decide applies one approver decision via primitives.applyDecision
 *   - approve is gated on isApproved(chain) → 422 approval.chain_incomplete
 *     while the chain is pending or rejected
 *   - POs without an attached chain still approve directly (SME path)
 *
 * Subject type is `purchase_order_internal` (not `purchase_order`, which is
 * Flow's procurement subject). The chain workflow is contributed by the
 * unified `withApprovalChain` preset (`#core/approval`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let env: ScenarioEnv;
let productId: string;
let supplierId: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const sku = `PO-CHAIN-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: `PO Chain Widget ${ts}`,
    slug: `po-chain-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    basePrice: 1000,
    costPrice: 500,
    identifiers: { custom: { sku } },
    isActive: true,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku };
}

async function seedSupplier(): Promise<string> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const r = await db.collection('purchase_suppliers').insertOne({
    organizationId: new mongoose.Types.ObjectId(env.orgId),
    code: `SUP-${ts}`,
    name: 'PO Chain Supplier',
    type: 'distributor',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId.toString();
}

function authH() {
  return env.auth.as('admin').headers as Record<string, string>;
}

async function createDraftPO(): Promise<string> {
  const createRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders`,
    headers: authH(),
    payload: {
      supplierId,
      paymentTerms: 'cash',
      items: [{ productId, quantity: 5, costPrice: 250 }],
    },
  });
  expect(createRes.statusCode, createRes.body).toBeLessThan(400);
  return (parse(createRes.body) as { _id: string })._id;
}

function action(poId: string, payload: Record<string, unknown>) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders/${poId}/action`,
    headers: authH(),
    payload,
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'po-chain' });

  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );

  const product = await seedProduct();
  productId = product.id;
  supplierId = await seedSupplier();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Purchase Order approval chain', () => {
  it('SME path: PO without an attached chain still approves directly', async () => {
    const poId = await createDraftPO();
    const ok = await action(poId, { action: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    const body = parse(ok.body) as { status: string };
    expect(body.status).toBe('approved');
  });

  it('sequential 2-step: approve is blocked at 422 until chain finishes', async () => {
    const poId = await createDraftPO();

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
    expect(submitRes.statusCode, submitRes.body).toBe(200);
    const submitted = parse(submitRes.body) as { approvals?: { status: string } };
    expect(submitted.approvals?.status).toBe('pending');

    // approve before any decision → 422
    const earlyApprove = await action(poId, { action: 'approve' });
    expect(earlyApprove.statusCode).toBe(422);
    expect((parse(earlyApprove.body) as { code?: string }).code).toBe('approval.chain_incomplete');

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
    const finalChain = parse(financeOk.body) as { approvals?: { status: string } };
    expect(finalChain.approvals?.status).toBe('approved');

    // approve now succeeds
    const finalApprove = await action(poId, { action: 'approve' });
    expect(finalApprove.statusCode, finalApprove.body).toBe(200);
    expect((parse(finalApprove.body) as { status: string }).status).toBe('approved');
  });

  it('rejection at any step puts chain in rejected and blocks approve', async () => {
    const poId = await createDraftPO();

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
    expect((parse(rejected.body) as { approvals?: { status: string } }).approvals?.status).toBe('rejected');

    const blocked = await action(poId, { action: 'approve' });
    expect(blocked.statusCode).toBe(422);
    expect((parse(blocked.body) as { code?: string }).code).toBe('approval.chain_incomplete');
  });

  it('rejects submit when status is outside draft (already approved)', async () => {
    const poId = await createDraftPO();
    // SME-approve first
    const okApprove = await action(poId, { action: 'approve' });
    expect(okApprove.statusCode).toBe(200);

    const submitRes = await action(poId, {
      action: 'submit_for_approval',
      chain: {
        order: 'sequential',
        steps: [{ id: 'sales', approvers: [{ id: 'rep-3' }] }],
      },
    });
    expect(submitRes.statusCode).toBe(422);
    expect((parse(submitRes.body) as { code?: string }).code).toBe('approval.invalid_status_for_submit');
  });
});
