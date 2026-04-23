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
 *   import { PRODUCTS, LOC, setupBranch, seedStock, adjustStock, getStock, getCostLayers } from '../helpers/erp-seed';
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

export async function setupBranch(flow: FlowEngine, orgId: string) {
  const uid = () => `${orgId.slice(-4)}-${Math.random().toString(36).slice(2, 6)}`;

  const node = await flow.models.InventoryNode.create({
    organizationId: orgId,
    code: 'DEFAULT',
    name: 'Default Warehouse',
    type: 'warehouse',
    status: 'active',
    isDefault: true,
  });
  const nodeId = node._id.toString();

  await flow.models.Location.create({
    organizationId: orgId, nodeId, code: LOC.stock, name: 'Stock',
    type: 'storage', status: 'active', allowNegativeStock: false,
    allowReservations: true, barcode: `BC-STK-${uid()}`,
  });
  await flow.models.Location.create({
    organizationId: orgId, nodeId, code: LOC.vendor, name: 'Vendor',
    type: 'vendor', status: 'active', allowNegativeStock: true, barcode: `BC-VND-${uid()}`,
  });
  await flow.models.Location.create({
    organizationId: orgId, nodeId, code: LOC.customer, name: 'Customer',
    type: 'customer', status: 'active', allowNegativeStock: true, barcode: `BC-CST-${uid()}`,
  });
  await flow.models.Location.create({
    organizationId: orgId, nodeId, code: LOC.adjustment, name: 'Adjustment',
    type: 'inventory_loss', status: 'active', allowNegativeStock: true, barcode: `BC-ADJ-${uid()}`,
  });

  return { nodeId };
}

// ── Stock Seeding ────────────────────────────────────────────────────────────

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
  const group = await flow.services.moveGroup.create(
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
  );
  await flow.services.moveGroup.executeAction(group._id.toString(), 'confirm', {}, ctx(orgId));
  await flow.services.moveGroup.executeAction(group._id.toString(), 'receive', {}, ctx(orgId));

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
    const outGroup = await flow.services.moveGroup.create(
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
    );
    await flow.services.moveGroup.executeAction(outGroup._id.toString(), 'confirm', {}, ctx(senderOrgId));
    await flow.services.moveGroup.executeAction(outGroup._id.toString(), 'receive', {}, ctx(senderOrgId));

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
    const inGroup = await flow.services.moveGroup.create(
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
    );
    await flow.services.moveGroup.executeAction(inGroup._id.toString(), 'confirm', {}, ctx(receiverOrgId));
    await flow.services.moveGroup.executeAction(inGroup._id.toString(), 'receive', {}, ctx(receiverOrgId));
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
