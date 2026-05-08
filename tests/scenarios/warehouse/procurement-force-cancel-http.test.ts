/**
 * Procurement Force-Cancel HTTP integration test.
 *
 * Drives the action wiring through the full HTTP pipeline:
 *
 *   1. Create PO via POST /inventory/procurement
 *   2. Approve via POST /:id/action { action: "approve" }
 *   3. Receive via POST /:id/receive (status → 'received')
 *   4. Force-cancel via POST /:id/action { action: "force-cancel", reason }
 *   5. Verify PO status === 'cancelled'
 *   6. Verify the kernel emitted `flow.procurement.cancelled` with
 *      hadReceipts=true (the bridge would post the reversal JE)
 *
 * Plus the safety contract:
 *
 *   - Plain "cancel" action on a fully-received PO returns 400/500
 *     (kernel rejects without `force: true`).
 *   - Force-cancel on a draft PO works and emits hadReceipts=false.
 *
 * The reversal JE math itself is locked by:
 *   tests/unit/vendor-bill-reversal-contract.test.ts (shape)
 *   tests/scenarios/warehouse/procurement-cancel-return-bridge.test.ts (wiring)
 *
 * This file pins only the HTTP action surface — that the FE button
 * actually flows through to the kernel verb.
 */

import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'procurement-force-cancel',
    env: { FLOW_MODE: 'standard', ENABLE_ACCOUNTING: 'true' },
  });
  server = env.server;

  // Procurement routes require `superadmin` role. `bootScenarioApp` provisions
  // plain `admin`; promote in place (same trick as `wms-procurement-smoke`).
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
}, 240_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(): Record<string, string> {
  return env.auth.as('admin').headers;
}

interface CapturedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function captureEvent(name: string, captured: CapturedEvent[]): Promise<() => void> {
  return import('#lib/events/arcEvents.js').then(({ subscribe }) =>
    subscribe(name, async (e) => {
      captured.push({ type: e.type, payload: e.payload as Record<string, unknown> });
    }),
  );
}

async function bootstrapWarehouse(): Promise<{ nodeId: string; storageLocationId: string }> {
  const nodes = JSON.parse(
    (
      await server.inject({
        method: 'GET',
        url: `${API}/inventory/nodes`,
        headers: h(),
      })
    ).body,
  );
  const nodeId = String(nodes[0]._id);

  const locations = JSON.parse(
    (
      await server.inject({
        method: 'GET',
        url: `${API}/inventory/locations?nodeId=${encodeURIComponent(nodeId)}`,
        headers: h(),
      })
    ).body,
  );
  const storage = (locations as Array<{ _id: string; type: string }>).find(
    (l) => l.type === 'storage' || l.type === 'stock',
  );
  const storageLocationId = String((storage ?? locations[0])._id);

  return { nodeId, storageLocationId };
}

async function createApproveReceive(input: {
  nodeId: string;
  storageLocationId: string;
  vendorRef: string;
  skuRef: string;
  qty: number;
  unitCost: number;
}): Promise<string> {
  const create = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement`,
    headers: h(),
    payload: {
      vendorRef: input.vendorRef,
      destinationNodeId: input.nodeId,
      destinationLocationId: input.storageLocationId,
      items: [{ skuRef: input.skuRef, quantity: input.qty, unitCost: input.unitCost }],
    },
  });
  expect([200, 201]).toContain(create.statusCode);
  const id = String(JSON.parse(create.body)._id);

  const approve = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/action`,
    headers: h(),
    payload: { action: 'approve' },
  });
  expect(approve.statusCode).toBe(200);

  const receive = await server.inject({
    method: 'POST',
    url: `${API}/inventory/procurement/${id}/receive`,
    headers: h(),
    payload: {
      lines: [{ skuRef: input.skuRef, quantityReceived: input.qty }],
    },
  });
  expect(receive.statusCode).toBe(200);
  return id;
}

describe('Procurement Force-Cancel — HTTP integration', () => {
  it('rejects plain `cancel` action on a fully-received PO', async () => {
    const { nodeId, storageLocationId } = await bootstrapWarehouse();
    const poId = await createApproveReceive({
      nodeId,
      storageLocationId,
      vendorRef: 'FORCE-V-1',
      skuRef: 'FORCE-SKU-1',
      qty: 5,
      unitCost: 10,
    });

    // Confirm PO is in 'received' status before we try to cancel.
    const detail = await server.inject({
      method: 'GET',
      url: `${API}/inventory/procurement/${poId}`,
      headers: h(),
    });
    expect(JSON.parse(detail.body).status).toBe('received');

    const cancelRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/procurement/${poId}/action`,
      headers: h(),
      payload: { action: 'cancel' },
    });
    // Kernel ValidationError → Arc maps to 400 or 500 depending on handler.
    expect([400, 500]).toContain(cancelRes.statusCode);

    // Status should still be 'received'.
    const after = await server.inject({
      method: 'GET',
      url: `${API}/inventory/procurement/${poId}`,
      headers: h(),
    });
    expect(JSON.parse(after.body).status).toBe('received');
  }, 120_000);

  it('force-cancels a fully-received PO and emits flow.procurement.cancelled with hadReceipts=true', async () => {
    const captured: CapturedEvent[] = [];
    const unsub = await captureEvent('flow.procurement.cancelled', captured);

    try {
      const { nodeId, storageLocationId } = await bootstrapWarehouse();
      const poId = await createApproveReceive({
        nodeId,
        storageLocationId,
        vendorRef: 'FORCE-V-2',
        skuRef: 'FORCE-SKU-2',
        qty: 3,
        unitCost: 25,
      });

      const forceRes = await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement/${poId}/action`,
        headers: h(),
        payload: { action: 'force-cancel', reason: 'wrong vendor invoice' },
      });
      expect(forceRes.statusCode).toBe(200);
      const body = JSON.parse(forceRes.body);
      expect(body.status).toBe('cancelled');

      // Flow events are async — give the subscriber a tick to drain.
      await new Promise((r) => setTimeout(r, 1000));

      const event = captured.find(
        (e) => (e.payload as { orderId?: string }).orderId === poId,
      );
      expect(event, 'flow.procurement.cancelled event expected').toBeDefined();
      expect((event?.payload as { hadReceipts?: boolean }).hadReceipts).toBe(true);
      expect((event?.payload as { priorStatus?: string }).priorStatus).toBe('received');
      expect((event?.payload as { reason?: string }).reason).toBe('wrong vendor invoice');
    } finally {
      unsub();
    }
  }, 120_000);

  it('force-cancels a draft PO and emits hadReceipts=false (no reversal needed)', async () => {
    const captured: CapturedEvent[] = [];
    const unsub = await captureEvent('flow.procurement.cancelled', captured);

    try {
      const { nodeId, storageLocationId } = await bootstrapWarehouse();
      const create = await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement`,
        headers: h(),
        payload: {
          vendorRef: 'FORCE-V-3',
          destinationNodeId: nodeId,
          destinationLocationId: storageLocationId,
          items: [{ skuRef: 'FORCE-SKU-3', quantity: 2, unitCost: 5 }],
        },
      });
      const poId = String(JSON.parse(create.body)._id);

      const forceRes = await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement/${poId}/action`,
        headers: h(),
        payload: { action: 'force-cancel', reason: 'created by mistake' },
      });
      expect(forceRes.statusCode).toBe(200);
      expect(JSON.parse(forceRes.body).status).toBe('cancelled');

      await new Promise((r) => setTimeout(r, 1000));

      const event = captured.find(
        (e) => (e.payload as { orderId?: string }).orderId === poId,
      );
      expect(event).toBeDefined();
      expect((event?.payload as { hadReceipts?: boolean }).hadReceipts).toBe(false);
      expect((event?.payload as { priorStatus?: string }).priorStatus).toBe('draft');
    } finally {
      unsub();
    }
  }, 120_000);

  it('re-cancelling an already-cancelled PO is a no-op (no second event)', async () => {
    const captured: CapturedEvent[] = [];
    const unsub = await captureEvent('flow.procurement.cancelled', captured);

    try {
      const { nodeId, storageLocationId } = await bootstrapWarehouse();
      const create = await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement`,
        headers: h(),
        payload: {
          vendorRef: 'FORCE-V-4',
          destinationNodeId: nodeId,
          destinationLocationId: storageLocationId,
          items: [{ skuRef: 'FORCE-SKU-4', quantity: 1, unitCost: 1 }],
        },
      });
      const poId = String(JSON.parse(create.body)._id);

      // First cancel.
      await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement/${poId}/action`,
        headers: h(),
        payload: { action: 'cancel' },
      });
      await new Promise((r) => setTimeout(r, 500));
      const beforeCount = captured.filter(
        (e) => (e.payload as { orderId?: string }).orderId === poId,
      ).length;
      expect(beforeCount).toBe(1);

      // Second cancel — kernel returns the existing cancelled doc, NO event.
      await server.inject({
        method: 'POST',
        url: `${API}/inventory/procurement/${poId}/action`,
        headers: h(),
        payload: { action: 'cancel' },
      });
      await new Promise((r) => setTimeout(r, 500));
      const afterCount = captured.filter(
        (e) => (e.payload as { orderId?: string }).orderId === poId,
      ).length;
      expect(afterCount, 're-cancel must not emit a second event').toBe(1);
    } finally {
      unsub();
    }
  }, 120_000);
});
