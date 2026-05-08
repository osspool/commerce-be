/**
 * ERP Seed Data — shared fixtures for scenario-based integration tests.
 *
 * Mirrors be-prod's production patterns:
 * - String location codes ('stock', 'vendor', 'customer', 'adjustment')
 * - virtualLocations override { adjustment: 'adjustment' }
 * - Dual-context transfers (sender + receiver)
 * - Cost layer creation alongside quant seeding
 *
 * Usage:
 *   import { PRODUCTS, LOC, setupBranch, seedStock, adjustStock, getStock, getCostLayers } from '../../support/erp-seed';
 */

import mongoose from 'mongoose';
import type { FlowEngine, FlowContext } from '@classytic/flow';

// ── Constants ────────────────────────────────────────────────────────────────

export const LOC = {
  stock: 'stock',
  vendor: 'vendor',
  customer: 'customer',
  adjustment: 'adjustment',
} as const;

export const PRODUCTS = {
  TSHIRT_RED_M: { sku: 'TSHIRT-RED-M', name: 'T-Shirt Red M', costPrice: 450 },
  TSHIRT_RED_L: { sku: 'TSHIRT-RED-L', name: 'T-Shirt Red L', costPrice: 450 },
  JACKET_BLK: { sku: 'JACKET-BLK', name: 'Jacket Black', costPrice: 1200 },
  PERFUME_50ML: { sku: 'PERFUME-50ML', name: 'Perfume 50ml', costPrice: 800 },
} as const;

// ── Context ──────────────────────────────────────────────────────────────────

export function ctx(orgId: string, actorId = 'test-actor'): FlowContext {
  return { organizationId: orgId, actorId };
}

// ── Branch Setup ─────────────────────────────────────────────────────────────

/**
 * Idempotent branch scaffolding. The setupFiles boot reuses one
 * MongoMemoryServer per worker, so a scenario file's beforeAll can land on
 * a `flow_inventory_nodes` collection that already has a `(orgId, 'DEFAULT')`
 * row from a previous file — `.create()` would throw E11000 there. Upsert
 * makes setup truly per-test-orgId-safe and lets the same orgId be reseeded
 * mid-suite (e.g. after a `cleanAll` between describe blocks).
 */
export async function setupBranch(flow: FlowEngine, orgId: string) {
  const uid = () => `${orgId.slice(-4)}-${Math.random().toString(36).slice(2, 6)}`;

  const node = await flow.models.InventoryNode.findOneAndUpdate(
    { organizationId: orgId, code: 'DEFAULT' },
    {
      $setOnInsert: {
        organizationId: orgId,
        code: 'DEFAULT',
        name: 'Default Warehouse',
        type: 'warehouse',
        status: 'active',
        isDefault: true,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const nodeId = node._id.toString();

  const locations: Array<{ code: string; name: string; type: string; allowNegativeStock: boolean; barcode: string; allowReservations?: boolean }> = [
    { code: LOC.stock, name: 'Stock', type: 'storage', allowNegativeStock: false, allowReservations: true, barcode: `BC-STK-${uid()}` },
    { code: LOC.vendor, name: 'Vendor', type: 'vendor', allowNegativeStock: true, barcode: `BC-VND-${uid()}` },
    { code: LOC.customer, name: 'Customer', type: 'customer', allowNegativeStock: true, barcode: `BC-CST-${uid()}` },
    { code: LOC.adjustment, name: 'Adjustment', type: 'inventory_loss', allowNegativeStock: true, barcode: `BC-ADJ-${uid()}` },
  ];
  for (const loc of locations) {
    await flow.models.Location.findOneAndUpdate(
      { organizationId: orgId, code: loc.code },
      {
        $setOnInsert: {
          organizationId: orgId,
          nodeId,
          code: loc.code,
          name: loc.name,
          type: loc.type,
          status: 'active',
          allowNegativeStock: loc.allowNegativeStock,
          ...(loc.allowReservations !== undefined ? { allowReservations: loc.allowReservations } : {}),
          barcode: loc.barcode,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
  }

  // Warm up the `flow_stock_events` collection. `ensureFlowReady` calls
  // `Model.createCollection()` on every flow model, but MongoMemoryReplSet
  // promotes a collection from local-only to replicated only on its first
  // WRITE. The first transactional write to `flow_stock_events` (fired by
  // procurement.receive / postMove / transfer-receive) trips a
  // catalog-change retry inside Mongo's `session.withTransaction` and the
  // txn aborts before the retry resolves. One write+delete here, outside
  // any transaction, forces full catalog propagation. Production never
  // sees this — it's a MongoMemoryReplSet artifact — but the warmup is a
  // no-op there. Idempotent: each setupBranch call re-warms the collection,
  // which is harmless since we delete the probe doc.
  const stockEventColl = (flow.models as Record<string, { collection?: { insertOne: (d: unknown) => Promise<{ insertedId: unknown }>; deleteOne: (q: unknown) => Promise<unknown> } }>).StockEvent?.collection;
  if (stockEventColl) {
    try {
      const probe = await stockEventColl.insertOne({ __warmup: true, ts: Date.now() });
      await stockEventColl.deleteOne({ _id: probe.insertedId });
    } catch {
      // Best-effort — surface the underlying transactional retry instead.
    }
  }

  return { nodeId };
}

// ── Stock Seeding ────────────────────────────────────────────────────────────

/**
 * Retry an op on the well-known mongodb-memory-server transient errors
 * that fire when forks create indexes on the same collection in parallel,
 * or when a transaction races a concurrent collection operation. These
 * are environmental, not bugs — production MongoDB does not see them.
 *
 * Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (≈3.1s total).
 */
async function withMongoRetry<T>(
  fn: () => Promise<T>,
  attempts = 6,
  baseDelayMs = 100,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const transient =
        msg.includes('catalog changes') ||
        msg.includes('WriteConflict') ||
        msg.includes('TransactionCoordinatorReachedAbortDecision') ||
        msg.includes('please retry') ||
        msg.includes('PleaseRetry') ||
        msg.includes('UnknownTransactionCommitResult') ||
        msg.includes('TransientTransactionError') ||
        msg.includes('WriteConcernError') ||
        msg.includes('NoSuchTransaction');
      if (!transient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

/**
 * Seeds stock at a branch: creates quant + cost layer in one call.
 * This is the "goods receipt" shortcut — equivalent to procurement receive.
 */
export async function seedStock(
  flow: FlowEngine,
  orgId: string,
  sku: string,
  qty: number,
  unitCost: number,
) {
  // Pre-seed the adjustment location quant with unitCost so that when
  // PostingService processes the inbound move (adjustment → stock), it
  // reads the cost and creates a cost layer automatically.
  await flow.models.StockQuant.findOneAndUpdate(
    { organizationId: orgId, skuRef: sku, locationId: LOC.adjustment },
    { $set: { unitCost } },
    { upsert: true },
  );

  // Quant via adjustment: adjustment → stock
  // PostingService detects virtual source → stockable dest and auto-creates
  // a cost layer at stock with the source quant's unitCost.
  const group = await withMongoRetry(() =>
    flow.services.moveGroup.create(
      {
        groupType: 'adjustment',
        items: [{
          moveGroupId: '',
          operationType: 'adjustment',
          skuRef: sku,
          sourceLocationId: LOC.adjustment,
          destinationLocationId: LOC.stock,
          quantityPlanned: qty,
        }],
      },
      ctx(orgId),
    ),
  );
  await withMongoRetry(() =>
    flow.services.moveGroup.executeAction(group._id.toString(), 'confirm', {}, ctx(orgId)),
  );
  await withMongoRetry(() =>
    flow.services.moveGroup.executeAction(group._id.toString(), 'receive', {}, ctx(orgId)),
  );

  // Ensure stock quant unitCost is set (upsert WAC may compute differently)
  await flow.models.StockQuant.findOneAndUpdate(
    { organizationId: orgId, skuRef: sku, locationId: LOC.stock },
    { $set: { unitCost } },
  );
}

// ── Stock Operations ─────────────────────────────────────────────────────────

/**
 * Adjust stock quantity via Flow MoveGroup (mimics inventory.controller.ts).
 */
export async function adjustStock(
  flow: FlowEngine,
  orgId: string,
  sku: string,
  currentQty: number,
  newQty: number,
) {
  const delta = newQty - currentQty;
  if (delta === 0) return;
  const source = delta > 0 ? LOC.adjustment : LOC.stock;
  const dest = delta > 0 ? LOC.stock : LOC.adjustment;

  // adjustStock is on the hot path of perf scenarios — keep it raw so the
  // wall-clock measurements aren't smeared by retry-backoff. The setup
  // helpers (`seedStock`, `transferBetweenBranches`) are the ones that
  // race on collection-create at suite boot.
  const group = await flow.services.moveGroup.create(
    {
      groupType: 'adjustment',
      items: [{
        moveGroupId: '',
        operationType: 'adjustment',
        skuRef: sku,
        sourceLocationId: source,
        destinationLocationId: dest,
        quantityPlanned: Math.abs(delta),
      }],
    },
    ctx(orgId),
  );
  await flow.services.moveGroup.executeAction(group._id.toString(), 'confirm', {}, ctx(orgId));
  await flow.services.moveGroup.executeAction(group._id.toString(), 'receive', {}, ctx(orgId));
}

/**
 * Transfer stock between branches using dual Flow contexts.
 * Outbound at sender (stock → customer), inbound at receiver (vendor → stock).
 *
 * After inbound, sets the receiver's quant unitCost from the sender's quant
 * so that PostingService's inbound layer creation picks up the correct cost.
 * In production, the transfer document carries cost metadata — this helper
 * simulates that by reading the sender's cost after the outbound.
 */
export async function transferBetweenBranches(
  flow: FlowEngine,
  senderOrgId: string,
  receiverOrgId: string,
  items: Array<{ sku: string; qty: number }>,
) {
  for (const item of items) {
    // Capture sender's unit cost BEFORE outbound (for receiver cost propagation)
    const senderQuant = await flow.models.StockQuant.findOne({
      organizationId: senderOrgId, skuRef: item.sku, locationId: LOC.stock,
    }).lean();
    const senderUnitCost = senderQuant?.unitCost ?? 0;

    // Outbound: sender decrements (stock → customer)
    const outGroup = await withMongoRetry(() =>
      flow.services.moveGroup.create(
        {
          groupType: 'shipment',
          items: [{
            moveGroupId: '',
            operationType: 'shipment',
            skuRef: item.sku,
            sourceLocationId: LOC.stock,
            destinationLocationId: LOC.customer,
            quantityPlanned: item.qty,
          }],
        },
        ctx(senderOrgId),
      ),
    );
    await withMongoRetry(() =>
      flow.services.moveGroup.executeAction(outGroup._id.toString(), 'confirm', {}, ctx(senderOrgId)),
    );
    await withMongoRetry(() =>
      flow.services.moveGroup.executeAction(outGroup._id.toString(), 'receive', {}, ctx(senderOrgId)),
    );

    // Pre-seed receiver's vendor location quant with sender's unitCost
    // so PostingService's inbound handler can read it for layer creation.
    // In production, the transfer document carries this cost metadata.
    if (senderUnitCost > 0) {
      await flow.models.StockQuant.findOneAndUpdate(
        { organizationId: receiverOrgId, skuRef: item.sku, locationId: LOC.vendor },
        { $set: { unitCost: senderUnitCost } },
        { upsert: true },
      );
    }

    // Inbound: receiver increments (vendor → stock)
    const inGroup = await withMongoRetry(() =>
      flow.services.moveGroup.create(
        {
          groupType: 'receipt',
          items: [{
            moveGroupId: '',
            operationType: 'receipt',
            skuRef: item.sku,
            sourceLocationId: LOC.vendor,
            destinationLocationId: LOC.stock,
            quantityPlanned: item.qty,
          }],
        },
        ctx(receiverOrgId),
      ),
    );
    await withMongoRetry(() =>
      flow.services.moveGroup.executeAction(inGroup._id.toString(), 'confirm', {}, ctx(receiverOrgId)),
    );
    await withMongoRetry(() =>
      flow.services.moveGroup.executeAction(inGroup._id.toString(), 'receive', {}, ctx(receiverOrgId)),
    );
  }
}

/**
 * Set exact cost layer state for a SKU at a location.
 *
 * Deletes ALL existing layers for the SKU and creates the given layers.
 * Use this for multi-receipt FIFO tests where you need precise control
 * over layer ordering and quantities.
 */
export async function setExactLayers(
  flow: FlowEngine,
  orgId: string,
  sku: string,
  layers: Array<{ qty: number; unitCost: number; receivedAt?: Date }>,
  locationId = LOC.stock,
) {
  // Clear existing layers for this SKU+location+org
  await flow.models.CostLayer.deleteMany({
    organizationId: orgId, skuRef: sku, locationId,
  });

  // Create exact layers in order
  const baseTime = new Date('2025-01-01').getTime();
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    await flow.models.CostLayer.create({
      organizationId: orgId,
      skuRef: sku,
      locationId,
      remainingQty: layer.qty,
      unitCost: layer.unitCost,
      receivedAt: layer.receivedAt ?? new Date(baseTime + i * 86_400_000),
      moveRef: `exact-layer-${i}-${Date.now()}`,
    });
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function getStock(flow: FlowEngine, orgId: string, sku: string, locationId = LOC.stock) {
  return flow.services.quant.getAvailability(
    { skuRef: sku, locationId },
    ctx(orgId),
  );
}

export async function getCostLayers(flow: FlowEngine, orgId: string, sku: string, locationId = LOC.stock) {
  return flow.models.CostLayer.find({
    organizationId: orgId,
    skuRef: sku,
    locationId,
    remainingQty: { $gt: 0 },
  }).sort({ receivedAt: 1 }).lean();
}

export async function cleanAll(flow: FlowEngine) {
  await Promise.all(
    Object.values(flow.models).map((m: any) => m.deleteMany({}).catch(() => {})),
  );
}
