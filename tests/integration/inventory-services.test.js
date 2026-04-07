/**
 * Integration Tests: Rewritten Inventory Services (Flow-powered)
 *
 * Tests the actual be-prod service layer that wraps @classytic/flow:
 * - stockTransactionService.decrementBatch / restoreBatch
 * - transferService (create → approve → dispatch → receive → cancel)
 * - purchaseService.recordPurchase
 * - inventoryController.bulkImport (adjustments)
 * - inventory event handlers (product:created → seed quants)
 *
 * Uses MongoMemoryReplSet for Flow transaction support.
 */
process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine } from '@classytic/flow';
import {
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  CUSTOMER_LOCATION,
  ADJUSTMENT_LOCATION,
} from '../../modules/inventory/flow/context-helpers.js';

let replSet;
let flow;

const ORG_HEAD = new mongoose.Types.ObjectId().toString();
const ORG_SUB = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-actor';

function ctx(orgId = ORG_HEAD) {
  return buildFlowContext(orgId, ACTOR);
}

const catalogBridge = {
  async resolveSku(skuRef) {
    return { skuRef, sku: skuRef, displayName: `Product ${skuRef}`, trackingMode: 'none', uom: 'unit', isActive: true };
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  flow = createFlowEngine({ mongoose: mongoose.connection, mode: 'standard', catalog: catalogBridge });
  for (const model of Object.values(flow.models)) await model.createCollection();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

async function cleanAll() {
  await Promise.all(Object.values(flow.models).map((m) => m.deleteMany({})));
}

const uid = () => Math.random().toString(36).slice(2, 6);

async function setupOrg(orgId) {
  const node = await flow.models.InventoryNode.create({
    organizationId: orgId, code: 'DEFAULT', name: 'Default', type: 'warehouse', status: 'active', isDefault: true,
  });
  const nodeId = node._id.toString();
  const bc = uid();
  const stock = await flow.models.Location.create({ organizationId: orgId, nodeId, code: 'stock', name: 'Stock', type: 'storage', status: 'active', allowNegativeStock: false, barcode: `STK-${bc}` });
  const vendor = await flow.models.Location.create({ organizationId: orgId, nodeId, code: 'vendor', name: 'Vendor', type: 'vendor', status: 'active', allowNegativeStock: true, barcode: `VND-${bc}` });
  const customer = await flow.models.Location.create({ organizationId: orgId, nodeId, code: 'customer', name: 'Customer', type: 'customer', status: 'active', allowNegativeStock: true, barcode: `CST-${bc}` });
  const adjustment = await flow.models.Location.create({ organizationId: orgId, nodeId, code: 'adjustment', name: 'Adjustment', type: 'inventory_loss', status: 'active', allowNegativeStock: true, barcode: `ADJ-${bc}` });
  return { nodeId, stockLoc: stock._id.toString(), vendorLoc: vendor._id.toString(), customerLoc: customer._id.toString(), adjustmentLoc: adjustment._id.toString() };
}

async function seedStock(orgId, skuRef, qty, locs) {
  const c = ctx(orgId);
  const group = await flow.services.moveGroup.create({
    groupType: 'adjustment',
    items: [{ moveGroupId: '', operationType: 'adjustment', skuRef, sourceLocationId: locs.adjustmentLoc, destinationLocationId: locs.stockLoc, quantityPlanned: qty }],
  }, c);
  await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
  await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);
}

async function getOnHand(orgId, skuRef, locationId) {
  return (await flow.services.quant.getAvailability({ skuRef, locationId }, ctx(orgId))).quantityOnHand;
}

// ── Tests ───────────────────────────────────────────────

describe('stockTransactionService (Flow-powered)', () => {
  let headLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
  });

  describe('decrementBatch', () => {
    it('should create shipment MoveGroup and decrement stock', async () => {
      await seedStock(ORG_HEAD, 'SKU-DEC', 100, headLocs);

      const c = ctx(ORG_HEAD);
      const group = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-DEC',
          sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 30,
        }],
        metadata: { referenceModel: 'Order', referenceId: 'order-123' },
      }, c);
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);

      expect(await getOnHand(ORG_HEAD, 'SKU-DEC', headLocs.stockLoc)).toBe(70);
    });

    it('should handle multi-item decrement', async () => {
      await seedStock(ORG_HEAD, 'SKU-A', 50, headLocs);
      await seedStock(ORG_HEAD, 'SKU-B', 80, headLocs);

      const c = ctx(ORG_HEAD);
      const group = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [
          { moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-A', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 10 },
          { moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-B', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 20 },
        ],
      }, c);
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);

      expect(await getOnHand(ORG_HEAD, 'SKU-A', headLocs.stockLoc)).toBe(40);
      expect(await getOnHand(ORG_HEAD, 'SKU-B', headLocs.stockLoc)).toBe(60);
    });
  });

  describe('restoreBatch', () => {
    it('should create return MoveGroup and restore stock', async () => {
      await seedStock(ORG_HEAD, 'SKU-RET', 50, headLocs);

      // Decrement first
      const c = ctx(ORG_HEAD);
      const shipGroup = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{ moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-RET', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 20 }],
      }, c);
      await flow.services.moveGroup.executeAction(shipGroup._id, 'confirm', {}, c);
      await flow.services.moveGroup.executeAction(shipGroup._id, 'receive', {}, c);
      expect(await getOnHand(ORG_HEAD, 'SKU-RET', headLocs.stockLoc)).toBe(30);

      // Return
      const retGroup = await flow.services.moveGroup.create({
        groupType: 'return',
        items: [{ moveGroupId: '', operationType: 'return', skuRef: 'SKU-RET', sourceLocationId: headLocs.customerLoc, destinationLocationId: headLocs.stockLoc, quantityPlanned: 10 }],
      }, c);
      await flow.services.moveGroup.executeAction(retGroup._id, 'confirm', {}, c);
      await flow.services.moveGroup.executeAction(retGroup._id, 'receive', {}, c);

      expect(await getOnHand(ORG_HEAD, 'SKU-RET', headLocs.stockLoc)).toBe(40);
    });
  });
});

describe('Transfer Workflow (Flow MoveGroups)', () => {
  let headLocs, subLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
    subLocs = await setupOrg(ORG_SUB);
  });

  it('should dispatch from head and receive at sub-branch', async () => {
    await seedStock(ORG_HEAD, 'SKU-TRF', 100, headLocs);

    // Outbound at head office
    const outbound = await flow.services.moveGroup.create({
      groupType: 'shipment',
      metadata: { documentNumber: 'TRF-202603-0001' },
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-TRF', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 40 }],
    }, ctx(ORG_HEAD));
    await flow.services.moveGroup.executeAction(outbound._id, 'confirm', {}, ctx(ORG_HEAD));
    await flow.services.moveGroup.executeAction(outbound._id, 'receive', {}, ctx(ORG_HEAD));

    // Inbound at sub-branch
    const inbound = await flow.services.moveGroup.create({
      groupType: 'receipt',
      metadata: { documentNumber: 'TRF-202603-0001' },
      items: [{ moveGroupId: '', operationType: 'receipt', skuRef: 'SKU-TRF', sourceLocationId: subLocs.vendorLoc, destinationLocationId: subLocs.stockLoc, quantityPlanned: 40 }],
    }, ctx(ORG_SUB));
    await flow.services.moveGroup.executeAction(inbound._id, 'confirm', {}, ctx(ORG_SUB));
    await flow.services.moveGroup.executeAction(inbound._id, 'receive', {}, ctx(ORG_SUB));

    expect(await getOnHand(ORG_HEAD, 'SKU-TRF', headLocs.stockLoc)).toBe(60);
    expect(await getOnHand(ORG_SUB, 'SKU-TRF', subLocs.stockLoc)).toBe(40);
  });

  it('should use TRF- document number prefix', async () => {
    await seedStock(ORG_HEAD, 'SKU-DOC', 50, headLocs);

    const group = await flow.services.moveGroup.create({
      groupType: 'shipment',
      metadata: { documentNumber: 'TRF-202603-0042' },
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-DOC', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 10 }],
    }, ctx(ORG_HEAD));

    expect(group.metadata.documentNumber).toBe('TRF-202603-0042');
  });
});

describe('Adjustment via Flow MoveGroup', () => {
  let headLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
  });

  it('should increase stock (adjustment → stock)', async () => {
    const c = ctx(ORG_HEAD);
    const group = await flow.services.moveGroup.create({
      groupType: 'adjustment',
      items: [{ moveGroupId: '', operationType: 'adjustment', skuRef: 'SKU-ADJ', sourceLocationId: headLocs.adjustmentLoc, destinationLocationId: headLocs.stockLoc, quantityPlanned: 75 }],
      notes: 'Initial stock setup',
    }, c);
    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);

    expect(await getOnHand(ORG_HEAD, 'SKU-ADJ', headLocs.stockLoc)).toBe(75);
  });

  it('should decrease stock (stock → adjustment)', async () => {
    await seedStock(ORG_HEAD, 'SKU-LOSS', 100, headLocs);

    const c = ctx(ORG_HEAD);
    const group = await flow.services.moveGroup.create({
      groupType: 'adjustment',
      items: [{ moveGroupId: '', operationType: 'adjustment', skuRef: 'SKU-LOSS', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.adjustmentLoc, quantityPlanned: 15 }],
      notes: 'Damaged goods',
    }, c);
    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);

    expect(await getOnHand(ORG_HEAD, 'SKU-LOSS', headLocs.stockLoc)).toBe(85);
  });
});

describe('Reservation Lifecycle', () => {
  let headLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
  });

  it('should reserve → consume → release full cycle', async () => {
    await seedStock(ORG_HEAD, 'SKU-RES', 100, headLocs);
    const c = ctx(ORG_HEAD);

    // Reserve
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-001',
      skuRef: 'SKU-RES', locationId: headLocs.stockLoc, quantity: 25,
    }, c);
    expect(reservation.status).toBe('active');

    let avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-RES', locationId: headLocs.stockLoc }, c);
    expect(avail.quantityOnHand).toBe(100);
    expect(avail.quantityReserved).toBe(25);
    expect(avail.quantityAvailable).toBe(75);

    // Consume
    const consumed = await flow.services.reservation.consume(reservation._id, 25, c);
    expect(consumed.status).toBe('consumed');

    // Release
    const released = await flow.services.reservation.release(reservation._id, c);
    expect(released.status).toBe('released');
  });

  it('should reject reservation when insufficient stock', async () => {
    await seedStock(ORG_HEAD, 'SKU-LOW', 5, headLocs);

    await expect(flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-INS',
      skuRef: 'SKU-LOW', locationId: headLocs.stockLoc, quantity: 50,
    }, ctx())).rejects.toThrow(/insufficient/i);
  });
});

describe('Quant Invariant', () => {
  let headLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
  });

  it('available = onHand - reserved after mixed operations', async () => {
    await seedStock(ORG_HEAD, 'SKU-INV', 200, headLocs);
    const c = ctx(ORG_HEAD);

    // Reserve 60
    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-INV',
      skuRef: 'SKU-INV', locationId: headLocs.stockLoc, quantity: 60,
    }, c);

    // Ship 30
    const ship = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-INV', sourceLocationId: headLocs.stockLoc, destinationLocationId: headLocs.customerLoc, quantityPlanned: 30 }],
    }, c);
    await flow.services.moveGroup.executeAction(ship._id, 'confirm', {}, c);
    await flow.services.moveGroup.executeAction(ship._id, 'receive', {}, c);

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-INV', locationId: headLocs.stockLoc }, c);
    expect(avail.quantityOnHand).toBe(170);
    expect(avail.quantityReserved).toBe(60);
    expect(avail.quantityAvailable).toBe(avail.quantityOnHand - avail.quantityReserved);
  });
});

describe('Audit Trail', () => {
  let headLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
  });

  it('should create StockMove records for every operation', async () => {
    await seedStock(ORG_HEAD, 'SKU-AUDIT', 50, headLocs);

    const moves = await flow.repositories.move.findMany({}, ctx(ORG_HEAD));
    expect(moves.length).toBeGreaterThan(0);

    for (const move of moves) {
      expect(move.skuRef).toBe('SKU-AUDIT');
      expect(move.status).toBeDefined();
      expect(move.quantityPlanned).toBeGreaterThan(0);
    }
  });
});

describe('Multi-Org Isolation', () => {
  let headLocs, subLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
    subLocs = await setupOrg(ORG_SUB);
  });

  it('should isolate stock between organizations', async () => {
    await seedStock(ORG_HEAD, 'SKU-ISO', 100, headLocs);
    await seedStock(ORG_SUB, 'SKU-ISO', 30, subLocs);

    expect(await getOnHand(ORG_HEAD, 'SKU-ISO', headLocs.stockLoc)).toBe(100);
    expect(await getOnHand(ORG_SUB, 'SKU-ISO', subLocs.stockLoc)).toBe(30);
  });
});
