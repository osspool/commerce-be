/**
 * Procurement Cancel + Supplier-Return → Accounting bridge integration test.
 *
 * Mirrors `transfer-accounting-bridge.test.ts`. Verifies the wiring between
 * the new flow kernel events (`flow.procurement.cancelled`,
 * `flow.procurement.supplier_returned`) and the host
 * `procurement-cancel-return.bridge.ts` against MongoMemory.
 *
 *   1. cancel with hadReceipts=false → no JE (cancel-from-draft path)
 *   2. cancel with hadReceipts=true  → reversal JE keyed by purchase id
 *   3. supplier_returned with priced lines → offset JE keyed by (po, mg)
 *   4. supplier_returned where some lines lack unitCost → bridge backfills from PO
 *
 * The contract shape (account codes, debit/credit sides, idempotency keys)
 * is unit-tested at `tests/unit/vendor-bill-reversal-contract.test.ts`. This
 * file pins the wiring — that the right event names trigger the right JE
 * writes against the right branch.
 */

import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let branchId: string;

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'procurement-cancel-return-bridge',
    env: { FLOW_MODE: 'standard', ENABLE_ACCOUNTING: 'true' },
  });
  server = env.server;
  branchId = env.orgId;
}, 240_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

void server; // app is held for lifecycle; no HTTP injection in this file.

async function readPurchaseJEs(orgId: string): Promise<Array<Record<string, unknown>>> {
  const db = mongoose.connection.db!;
  return db
    .collection('journalentries')
    .find({ organizationId: new mongoose.Types.ObjectId(orgId), journalType: 'PURCHASES' })
    .sort({ createdAt: -1 })
    .toArray() as unknown as Array<Record<string, unknown>>;
}

async function publishEvent(name: string, payload: Record<string, unknown>, orgId: string): Promise<void> {
  const { publish } = await import('#lib/events/arcEvents.js');
  void publish(name, payload, { organizationId: orgId });
  // Bridges are async; allow the subscription tick to drain.
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Seed a minimal ProcurementOrder document so the bridge can read its
 * items[] when re-deriving totals. We don't go through `services.procurement.create`
 * because the bridge logic is what's under test; the kernel verb is unit-tested
 * separately in flow.
 */
async function seedProcurementOrder(input: {
  orderNumber: string;
  vendorRef: string;
  organizationId: string;
  status: string;
  items: Array<{ skuRef: string; quantity: number; quantityReceived: number; unitCost: number; tax?: number; taxRate?: number }>;
}): Promise<string> {
  // Seed through the flow engine's model so the document matches the
  // schema exactly (tenant field, indexes, defaults). Insert directly via
  // mongoose.connection won't trigger schema-level transforms, which the
  // engine's repository expects when reading back.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const engine = getFlowEngine();
  // biome-ignore lint/suspicious/noExplicitAny: model surface is loose
  const ProcurementOrderModel = engine.models.ProcurementOrder as any;
  const created = await ProcurementOrderModel.create({
    organizationId: new mongoose.Types.ObjectId(input.organizationId),
    orderNumber: input.orderNumber,
    vendorRef: input.vendorRef,
    // Schema requires a node id even though the bridge only reads items/totals.
    destinationNodeId: new mongoose.Types.ObjectId(),
    status: input.status,
    items: input.items,
    receivedAt: new Date(),
  });
  return String(created._id);
}

describe('procurement cancel/return accounting bridge', () => {
  it('skips posting when hadReceipts=false (cancel-from-draft)', async () => {
    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-CANCEL-DRAFT',
      vendorRef: 'vendor-x',
      organizationId: branchId,
      status: 'cancelled',
      items: [{ skuRef: 'SKU-A', quantity: 5, quantityReceived: 0, unitCost: 100 }],
    });

    const before = await readPurchaseJEs(branchId);
    const beforeCount = before.length;

    await publishEvent(
      'flow.procurement.cancelled',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-CANCEL-DRAFT',
        vendorRef: 'vendor-x',
        hadReceipts: false,
        priorStatus: 'approved',
      },
      branchId,
    );

    const after = await readPurchaseJEs(branchId);
    expect(after).toHaveLength(beforeCount);
  }, 60_000);

  it('posts a reversal JE keyed by purchase id when hadReceipts=true', async () => {
    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-CANCEL-RECEIVED',
      vendorRef: 'vendor-y',
      organizationId: branchId,
      status: 'cancelled',
      items: [
        // Net 5000 + 750 VAT (15%) = 5750 gross
        { skuRef: 'SKU-B', quantity: 50, quantityReceived: 50, unitCost: 100, taxRate: 15 },
      ],
    });

    await publishEvent(
      'flow.procurement.cancelled',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-CANCEL-RECEIVED',
        vendorRef: 'vendor-y',
        hadReceipts: true,
        priorStatus: 'received',
        reason: 'PO superseded',
      },
      branchId,
    );

    const jes = await readPurchaseJEs(branchId);
    const reversal = jes.find(
      (je) => (je.idempotencyKey as string | undefined) === `vendor-bill-${orderId}-reverse`,
    );
    expect(reversal, 'reversal JE expected').toBeDefined();
    expect(reversal?.label).toContain('PO superseded');

    const items = (reversal?.journalItems ?? []) as Array<{ debit?: number; credit?: number; accountCode?: string; partnerId?: string }>;
    const apLine = items.find((i) => Number(i.debit ?? 0) > 0 && Number(i.credit ?? 0) === 0);
    expect(apLine?.partnerId).toBe('vendor-y');
  }, 60_000);

  it('posts a supplier-return offset JE on flow.procurement.supplier_returned', async () => {
    const moveGroupId = new mongoose.Types.ObjectId().toString();

    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-RETURN-1',
      vendorRef: 'vendor-z',
      organizationId: branchId,
      status: 'received',
      items: [{ skuRef: 'SKU-C', quantity: 10, quantityReceived: 10, unitCost: 200 }],
    });

    await publishEvent(
      'flow.procurement.supplier_returned',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-RETURN-1',
        vendorRef: 'vendor-z',
        moveGroupId,
        lines: [{ skuRef: 'SKU-C', quantityReturned: 3, unitCost: 200 }],
      },
      branchId,
    );

    const jes = await readPurchaseJEs(branchId);
    const offset = jes.find(
      (je) => (je.idempotencyKey as string | undefined) === `supplier-return-${orderId}-${moveGroupId}`,
    );
    expect(offset, 'supplier-return offset JE expected').toBeDefined();
    expect(offset?.totalDebit).toBe(60_000); // 3 × 200 × 100 paisa
  }, 60_000);

  it('is idempotent — re-publishing the same cancellation event does not double-post', async () => {
    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-IDEMPOTENT-CANCEL',
      vendorRef: 'vendor-idem',
      organizationId: branchId,
      status: 'cancelled',
      items: [{ skuRef: 'SKU-IDEM', quantity: 10, quantityReceived: 10, unitCost: 50 }],
    });

    const payload = {
      organizationId: branchId,
      orderId,
      orderNumber: 'PO-IDEMPOTENT-CANCEL',
      vendorRef: 'vendor-idem',
      hadReceipts: true,
      priorStatus: 'received',
    };

    await publishEvent('flow.procurement.cancelled', payload, branchId);
    const after1 = await readPurchaseJEs(branchId);
    const reversalsAfter1 = after1.filter(
      (je) => (je.idempotencyKey as string | undefined) === `vendor-bill-${orderId}-reverse`,
    );
    expect(reversalsAfter1).toHaveLength(1);

    // Replay the exact same event — ledger idempotency must collapse it.
    await publishEvent('flow.procurement.cancelled', payload, branchId);
    const after2 = await readPurchaseJEs(branchId);
    const reversalsAfter2 = after2.filter(
      (je) => (je.idempotencyKey as string | undefined) === `vendor-bill-${orderId}-reverse`,
    );
    expect(reversalsAfter2).toHaveLength(1);
  }, 60_000);

  it('two distinct supplier returns against the same PO produce two JEs (different move groups)', async () => {
    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-TWO-RETURNS',
      vendorRef: 'vendor-multi',
      organizationId: branchId,
      status: 'received',
      items: [{ skuRef: 'SKU-X', quantity: 20, quantityReceived: 20, unitCost: 100 }],
    });

    const mg1 = new mongoose.Types.ObjectId().toString();
    const mg2 = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'flow.procurement.supplier_returned',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-TWO-RETURNS',
        vendorRef: 'vendor-multi',
        moveGroupId: mg1,
        lines: [{ skuRef: 'SKU-X', quantityReturned: 3, unitCost: 100 }],
      },
      branchId,
    );

    await publishEvent(
      'flow.procurement.supplier_returned',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-TWO-RETURNS',
        vendorRef: 'vendor-multi',
        moveGroupId: mg2,
        lines: [{ skuRef: 'SKU-X', quantityReturned: 5, unitCost: 100 }],
      },
      branchId,
    );

    // But replaying mg2 should NOT add a third.
    await publishEvent(
      'flow.procurement.supplier_returned',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-TWO-RETURNS',
        vendorRef: 'vendor-multi',
        moveGroupId: mg2,
        lines: [{ skuRef: 'SKU-X', quantityReturned: 5, unitCost: 100 }],
      },
      branchId,
    );

    const jes = await readPurchaseJEs(branchId);
    const returns = jes.filter((je) => {
      const key = je.idempotencyKey as string | undefined;
      return key === `supplier-return-${orderId}-${mg1}` || key === `supplier-return-${orderId}-${mg2}`;
    });
    expect(returns).toHaveLength(2);
  }, 60_000);

  it('back-fills missing unitCost from the PO items when re-deriving the JE', async () => {
    const moveGroupId = new mongoose.Types.ObjectId().toString();

    const orderId = await seedProcurementOrder({
      orderNumber: 'PO-RETURN-2',
      vendorRef: 'vendor-w',
      organizationId: branchId,
      status: 'received',
      items: [{ skuRef: 'SKU-D', quantity: 4, quantityReceived: 4, unitCost: 75 }],
    });

    await publishEvent(
      'flow.procurement.supplier_returned',
      {
        organizationId: branchId,
        orderId,
        orderNumber: 'PO-RETURN-2',
        vendorRef: 'vendor-w',
        moveGroupId,
        lines: [{ skuRef: 'SKU-D', quantityReturned: 2 }], // unitCost intentionally absent
      },
      branchId,
    );

    const jes = await readPurchaseJEs(branchId);
    const offset = jes.find(
      (je) => (je.idempotencyKey as string | undefined) === `supplier-return-${orderId}-${moveGroupId}`,
    );
    expect(offset, 'supplier-return offset JE should still post via PO backfill').toBeDefined();
    expect(offset?.totalDebit).toBe(15_000); // 2 × 75 × 100
  }, 60_000);
});
