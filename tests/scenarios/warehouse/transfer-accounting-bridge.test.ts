/**
 * Transfer → Accounting bridge integration test.
 *
 * Verifies the bridge subscription pipeline end-to-end against MongoMemory:
 *   1. `transfer:dispatched` published → JE lands tagged with senderBranchId
 *   2. `transfer:received` published → JE lands tagged with receiverBranchId
 *   3. Replay of the same event is idempotent (ledger dedup)
 *   4. costMissing path: zero-cost lines still produce a JE with metadata
 *
 * The bridge's posting CONTRACT (account codes, debit/credit sides, key
 * format) is unit-tested separately at tests/unit/transfer-contract.test.ts.
 * This file pins the wiring — that the right event names trigger the right
 * JE writes against the right branch.
 *
 * Why direct event publishing instead of the full transfer state machine:
 * the bridge subscribes to `transfer:dispatched` / `transfer:received`
 * regardless of who published them. Driving the entire HEAD_TO_SUB pipe
 * (PO seed → transfer create → 4 actions) just to fire the same events
 * adds harness complexity without verifying anything new about the bridge.
 * Full pipeline coverage lives in tests/probe-transfer-dual-context.mjs.
 */

import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSecondaryBranch, bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let hoBranchId: string;
let mainBranchId: string;
const SKU = 'TRF-BRIDGE-SKU';

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'transfer-bridge',
    env: { FLOW_MODE: 'standard', ENABLE_ACCOUNTING: 'true' },
  });
  server = env.server;
  hoBranchId = env.orgId;
  mainBranchId = await addSecondaryBranch(env, { slug: 'trf-main', branchRole: 'branch' });

  // Tag HO as head_office so the transfer service's role check would pass.
  // Not strictly required when we publish events directly, but kept so the
  // env reflects the real deployment topology.
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(hoBranchId) },
    { $set: { branchRole: 'head_office', branchType: 'warehouse', isDefault: true } },
  );
}, 240_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

async function readInventoryJEs(orgId: string): Promise<Array<Record<string, unknown>>> {
  const db = mongoose.connection.db!;
  return db
    .collection('journalentries')
    .find({ organizationId: new mongoose.Types.ObjectId(orgId), journalType: 'INVENTORY' })
    .sort({ createdAt: -1 })
    .toArray() as unknown as Array<Record<string, unknown>>;
}

async function publishEvent(name: string, payload: Record<string, unknown>, orgId: string): Promise<void> {
  const { publish } = await import('#lib/events/arcEvents.js');
  void publish(name, payload, { organizationId: orgId });
  // Bridges are async; give the subscription tick time to drain.
  await new Promise((r) => setTimeout(r, 1500));
}

describe('transfer accounting bridge', () => {
  it('posts a dispatch JE on the SENDER branch when transfer:dispatched fires', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'transfer:dispatched',
      {
        transferId,
        documentNumber: 'TRF-DISPATCH-001',
        senderBranchId: hoBranchId,
        items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
        dispatchedBy: 'test-user',
      },
      hoBranchId,
    );

    const jes = await readInventoryJEs(hoBranchId);
    const dispatchJE = jes.find(
      (je) => (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId,
    );

    expect(dispatchJE, 'dispatch JE not posted on HO').toBeDefined();
    expect(dispatchJE?.label).toContain('Transfer Dispatch');
    expect(dispatchJE?.idempotencyKey).toBe(`transfer-${transferId}-dispatch`);
    expect(dispatchJE?.organizationId?.toString()).toBe(hoBranchId);
  }, 60_000);

  it('posts a receive JE on the RECEIVER branch when transfer:received fires', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'transfer:received',
      {
        transferId,
        documentNumber: 'TRF-RECEIVE-001',
        senderBranchId: hoBranchId,
        receiverBranchId: mainBranchId,
        items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
        receivedBy: 'test-user',
      },
      mainBranchId,
    );

    const jes = await readInventoryJEs(mainBranchId);
    const receiveJE = jes.find(
      (je) => (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId,
    );

    expect(receiveJE, 'receive JE not posted on MAIN').toBeDefined();
    expect(receiveJE?.label).toContain('Transfer Receive');
    expect(receiveJE?.idempotencyKey).toBe(`transfer-${transferId}-receive`);
    expect(receiveJE?.organizationId?.toString()).toBe(mainBranchId);
  }, 60_000);

  it('does not double-post on retry — same key returns the same JE', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();
    const payload = {
      transferId,
      documentNumber: 'TRF-IDEMP-001',
      senderBranchId: hoBranchId,
      items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
      dispatchedBy: 'test-user',
    };

    await publishEvent('transfer:dispatched', payload, hoBranchId);
    await publishEvent('transfer:dispatched', payload, hoBranchId);

    const jes = await readInventoryJEs(hoBranchId);
    const matching = jes.filter(
      (je) => (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId,
    );

    expect(matching, `expected exactly one JE; got ${matching.length}`).toHaveLength(1);
  }, 60_000);

  it('no-op on transfer:cancelled when wasDispatched is false (draft cancel)', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();

    const beforeCount = (await readInventoryJEs(hoBranchId)).length;

    await publishEvent(
      'transfer:cancelled',
      {
        transferId,
        documentNumber: 'TRF-CANCEL-NOOP',
        senderBranchId: hoBranchId,
        receiverBranchId: mainBranchId,
        items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
        wasDispatched: false,
        wasReceived: false,
      },
      hoBranchId,
    );

    const afterCount = (await readInventoryJEs(hoBranchId)).length;
    // No JE should have been posted because wasDispatched is false.
    expect(afterCount).toBe(beforeCount);
  }, 60_000);

  it('posts a dispatch reversal when transfer:cancelled fires with wasDispatched=true', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'transfer:cancelled',
      {
        transferId,
        documentNumber: 'TRF-CANCEL-DISPATCH',
        senderBranchId: hoBranchId,
        receiverBranchId: mainBranchId,
        items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
        reason: 'shipped to wrong location',
        wasDispatched: true,
        wasReceived: false,
      },
      hoBranchId,
    );

    const jes = await readInventoryJEs(hoBranchId);
    const reversal = jes.find(
      (je) =>
        (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId &&
        (je.label as string)?.includes('REVERSED'),
    );

    expect(reversal, 'dispatch reversal JE should be posted on HO').toBeDefined();
    expect(reversal?.idempotencyKey).toBe(`transfer-${transferId}-dispatch-reversed`);
    expect(reversal?.label).toContain('shipped to wrong location');

    // No receive reversal — wasReceived was false.
    const mainJEs = await readInventoryJEs(mainBranchId);
    const receiveReversal = mainJEs.find(
      (je) => (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId,
    );
    expect(receiveReversal, 'receive reversal should NOT post when wasReceived is false').toBeUndefined();
  }, 60_000);

  it('posts BOTH reversals when wasDispatched and wasReceived are true', async () => {
    const transferId = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'transfer:cancelled',
      {
        transferId,
        documentNumber: 'TRF-CANCEL-FULL',
        senderBranchId: hoBranchId,
        receiverBranchId: mainBranchId,
        items: [{ product: SKU, variantSku: SKU, quantity: 1 }],
        wasDispatched: true,
        wasReceived: true,
      },
      hoBranchId,
    );

    const hoJEs = await readInventoryJEs(hoBranchId);
    const mainJEs = await readInventoryJEs(mainBranchId);

    const dispatchReversal = hoJEs.find(
      (je) => (je.idempotencyKey as string) === `transfer-${transferId}-dispatch-reversed`,
    );
    const receiveReversal = mainJEs.find(
      (je) => (je.idempotencyKey as string) === `transfer-${transferId}-receive-reversed`,
    );

    expect(dispatchReversal, 'dispatch reversal expected on HO').toBeDefined();
    expect(receiveReversal, 'receive reversal expected on MAIN').toBeDefined();
  }, 60_000);

  it('still posts a JE (with costMissing metadata) when cost cannot be resolved', async () => {
    // No procurement seeded for this SKU — getValuation returns 0, bridge
    // stamps costMissing: true and posts zero amounts so finance has the
    // audit trail rather than silently swallowing the event.
    const transferId = new mongoose.Types.ObjectId().toString();

    await publishEvent(
      'transfer:dispatched',
      {
        transferId,
        documentNumber: 'TRF-NOCOST-001',
        senderBranchId: hoBranchId,
        items: [{ product: 'UNSEEDED-SKU', variantSku: 'UNSEEDED-SKU', quantity: 1 }],
        dispatchedBy: 'test-user',
      },
      hoBranchId,
    );

    const jes = await readInventoryJEs(hoBranchId);
    const noCostJE = jes.find(
      (je) => (je.sourceRef as { sourceId?: string } | undefined)?.sourceId === transferId,
    );

    expect(noCostJE, 'JE should still post for audit trail when cost is missing').toBeDefined();
    const meta = noCostJE?.metadata as { costMissing?: boolean; affectedSkus?: string[] } | undefined;
    expect(meta?.costMissing).toBe(true);
    expect(meta?.affectedSkus).toContain('UNSEEDED-SKU');
  }, 60_000);
});
