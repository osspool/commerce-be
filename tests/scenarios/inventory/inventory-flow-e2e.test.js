/**
 * E2E Tests: Flow-based Inventory System
 *
 * Tests the full inventory lifecycle using @classytic/flow:
 * - Stock availability queries
 * - Adjustments (via MoveGroups)
 * - Reservations (reserve / release / consume)
 * - Transfers between branches (cross-org MoveGroups)
 * - Procurement (create → approve → receive)
 * - POS barcode lookup with cache
 * - Product event handlers (seeding quants)
 * - Negative stock guard
 * - Sub-branch restriction
 *
 * Uses MongoMemoryReplSet for Flow transaction support.
 */
process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine, ensureFlowReady } from '@classytic/flow';

// ── Test Setup ──────────────────────────────────────────

let replSet;
let flow;

const ORG_HEAD = new mongoose.Types.ObjectId().toString();
const ORG_SUB1 = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-actor';

function ctx(orgId = ORG_HEAD) {
  return { organizationId: orgId, actorId: ACTOR };
}

// Simple catalog bridge for tests
const catalogBridge = {
  async resolveSku(skuRef) {
    return {
      skuRef,
      sku: skuRef,
      displayName: `Product ${skuRef}`,
      trackingMode: 'none',
      uom: 'unit',
      isActive: true,
    };
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  await mongoose.connect(replSet.getUri());

  flow = createFlowEngine({
    mongoose: mongoose.connection,
    mode: 'standard',
    catalog: catalogBridge,
  });

  // Materialise all collections, build indexes, and warm up the replica-set
  // catalog so the first transactional write doesn't trip on catalog changes.
  await ensureFlowReady(flow, { warmupWrites: true });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

async function cleanAll() {
  // Sequential deleteMany avoids MongoDB's "catalog changes; please retry"
  // WriteConflict that fires when a subsequent transaction touches a
  // collection whose metadata was just modified by a parallel deleteMany.
  for (const m of Object.values(flow.models)) {
    // eslint-disable-next-line no-await-in-loop
    await m.deleteMany({});
  }
}

// Helper: create default node + locations for an org
async function setupOrg(orgId) {
  const node = await flow.models.InventoryNode.create({
    organizationId: orgId,
    code: 'DEFAULT',
    name: 'Default',
    type: 'warehouse',
    status: 'active',
    isDefault: true,
  });
  const nodeId = node._id.toString();

  const uid = () => `${orgId.slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
  const stock = await flow.models.Location.create({
    organizationId: orgId, nodeId, code: 'stock', name: 'Stock',
    type: 'storage', status: 'active', allowNegativeStock: false, barcode: `BC-STK-${uid()}`,
  });
  const vendor = await flow.models.Location.create({
    organizationId: orgId, nodeId, code: 'vendor', name: 'Vendor',
    type: 'vendor', status: 'active', allowNegativeStock: true, barcode: `BC-VND-${uid()}`,
  });
  const customer = await flow.models.Location.create({
    organizationId: orgId, nodeId, code: 'customer', name: 'Customer',
    type: 'customer', status: 'active', allowNegativeStock: true, barcode: `BC-CST-${uid()}`,
  });
  const adjustment = await flow.models.Location.create({
    organizationId: orgId, nodeId, code: 'adjustment', name: 'Adjustment',
    type: 'inventory_loss', status: 'active', allowNegativeStock: true, barcode: `BC-ADJ-${uid()}`,
  });

  return {
    nodeId,
    stockLoc: stock._id.toString(),
    vendorLoc: vendor._id.toString(),
    customerLoc: customer._id.toString(),
    adjustmentLoc: adjustment._id.toString(),
  };
}

// Helper: seed stock via adjustment MoveGroup
async function seedStock(orgId, skuRef, quantity, locations) {
  const c = ctx(orgId);
  const group = await flow.services.moveGroup.create({
    groupType: 'adjustment',
    items: [{
      moveGroupId: '', operationType: 'adjustment', skuRef,
      sourceLocationId: locations.adjustmentLoc,
      destinationLocationId: locations.stockLoc,
      quantityPlanned: quantity,
    }],
  }, c);
  await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, c);
  await flow.services.moveGroup.executeAction(group._id, 'receive', {}, c);
}

// Helper: get quant on-hand
async function getOnHand(orgId, skuRef, locationId) {
  const result = await flow.services.quant.getAvailability({ skuRef, locationId }, ctx(orgId));
  return result.quantityOnHand;
}

// ── Tests ───────────────────────────────────────────────

describe('Flow Inventory E2E', () => {
  let headLocs, subLocs;

  beforeEach(async () => {
    await cleanAll();
    headLocs = await setupOrg(ORG_HEAD);
    subLocs = await setupOrg(ORG_SUB1);
  });

  // ── AVAILABILITY ──

  describe('Stock Availability', () => {
    it('should return zero for unstocked SKU', async () => {
      const result = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-EMPTY', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(result.quantityOnHand).toBe(0);
      expect(result.quantityAvailable).toBe(0);
    });

    it('should return correct quantities after seeding', async () => {
      await seedStock(ORG_HEAD, 'SKU-A', 100, headLocs);

      const result = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-A', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(result.quantityOnHand).toBe(100);
      expect(result.quantityAvailable).toBe(100);
      expect(result.quantityReserved).toBe(0);
    });

    it('should check individual availability per SKU', async () => {
      await seedStock(ORG_HEAD, 'SKU-X', 50, headLocs);
      await seedStock(ORG_HEAD, 'SKU-Y', 10, headLocs);

      // Check each SKU individually at the storage location
      const availX = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-X', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(availX.quantityAvailable).toBe(50);

      const availY = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-Y', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(availY.quantityAvailable).toBe(10);

      // SKU-X can fulfill 30, SKU-Y cannot fulfill 20
      expect(availX.quantityAvailable >= 30).toBe(true);
      expect(availY.quantityAvailable >= 20).toBe(false);
    });
  });

  // ── ADJUSTMENTS ──

  describe('Stock Adjustments', () => {
    it('should increase stock via adjustment MoveGroup', async () => {
      await seedStock(ORG_HEAD, 'SKU-ADJ', 50, headLocs);

      expect(await getOnHand(ORG_HEAD, 'SKU-ADJ', headLocs.stockLoc)).toBe(50);

      // Add 30 more
      const group = await flow.services.moveGroup.create({
        groupType: 'adjustment',
        items: [{
          moveGroupId: '', operationType: 'adjustment', skuRef: 'SKU-ADJ',
          sourceLocationId: headLocs.adjustmentLoc,
          destinationLocationId: headLocs.stockLoc,
          quantityPlanned: 30,
        }],
      }, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

      expect(await getOnHand(ORG_HEAD, 'SKU-ADJ', headLocs.stockLoc)).toBe(80);
    });

    it('should decrease stock via adjustment MoveGroup', async () => {
      await seedStock(ORG_HEAD, 'SKU-DEC', 100, headLocs);

      // Remove 40
      const group = await flow.services.moveGroup.create({
        groupType: 'adjustment',
        items: [{
          moveGroupId: '', operationType: 'adjustment', skuRef: 'SKU-DEC',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.adjustmentLoc,
          quantityPlanned: 40,
        }],
      }, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

      expect(await getOnHand(ORG_HEAD, 'SKU-DEC', headLocs.stockLoc)).toBe(60);
    });

    it('should reject empty items in MoveGroup', async () => {
      // flow 0.3.0 validates service-boundary input via repo-core's
      // validateStandardSchema (Zod `items: z.array(...).min(1)`). Structural
      // failures now throw the org-standard HttpError 400 ('Validation
      // failed') with the field detail under `validationErrors`, instead of
      // flow's old domain-specific 'at least one item' message.
      await expect(
        flow.services.moveGroup.create({ groupType: 'adjustment', items: [] }, ctx()),
      ).rejects.toMatchObject({
        status: 400,
        validationErrors: expect.arrayContaining([
          expect.objectContaining({ error: expect.stringMatching(/items/i) }),
        ]),
      });
    });
  });

  // ── RESERVATIONS ──

  describe('Reservations', () => {
    it('should reserve stock and update available quantity', async () => {
      await seedStock(ORG_HEAD, 'SKU-RES', 100, headLocs);

      const reservation = await flow.services.reservation.reserve({
        reservationType: 'hard',
        ownerType: 'order',
        ownerId: 'ORD-001',
        skuRef: 'SKU-RES',
        locationId: headLocs.stockLoc,
        quantity: 30,
      }, ctx());

      expect(reservation.status).toBe('active');
      expect(reservation.quantity).toBe(30);

      const avail = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-RES', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(avail.quantityOnHand).toBe(100);
      expect(avail.quantityReserved).toBe(30);
      expect(avail.quantityAvailable).toBe(70);
    });

    it('should release reservation and restore available', async () => {
      await seedStock(ORG_HEAD, 'SKU-REL', 50, headLocs);

      const res = await flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-REL',
        skuRef: 'SKU-REL', locationId: headLocs.stockLoc, quantity: 20,
      }, ctx());

      const released = await flow.services.reservation.release(res._id, ctx());
      expect(released.status).toBe('released');

      const avail = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-REL', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(avail.quantityAvailable).toBe(50);
    });

    it('should consume reservation partially and fully', async () => {
      await seedStock(ORG_HEAD, 'SKU-CON', 100, headLocs);

      const res = await flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-CON',
        skuRef: 'SKU-CON', locationId: headLocs.stockLoc, quantity: 20,
      }, ctx());

      const partial = await flow.services.reservation.consume(res._id, 5, ctx());
      expect(partial.status).toBe('partially_consumed');

      const full = await flow.services.reservation.consume(res._id, 15, ctx());
      expect(full.status).toBe('consumed');
    });

    it('should reject reservation when insufficient stock', async () => {
      await seedStock(ORG_HEAD, 'SKU-LOW', 5, headLocs);

      await expect(
        flow.services.reservation.reserve({
          reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-INS',
          skuRef: 'SKU-LOW', locationId: headLocs.stockLoc, quantity: 50,
        }, ctx()),
      ).rejects.toThrow(/insufficient/i);
    });
  });

  // ── TRANSFERS (cross-org) ──

  describe('Transfers Between Branches', () => {
    it('should transfer stock between head office and sub-branch', async () => {
      await seedStock(ORG_HEAD, 'SKU-TRF', 100, headLocs);

      // Outbound: head → customer (virtual transit)
      const outbound = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-TRF',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 30,
        }],
      }, ctx(ORG_HEAD));
      await flow.services.moveGroup.executeAction(outbound._id, 'confirm', {}, ctx(ORG_HEAD));
      await flow.services.moveGroup.executeAction(outbound._id, 'receive', {}, ctx(ORG_HEAD));

      // Inbound: vendor → stock at sub-branch
      const inbound = await flow.services.moveGroup.create({
        groupType: 'receipt',
        items: [{
          moveGroupId: '', operationType: 'receipt', skuRef: 'SKU-TRF',
          sourceLocationId: subLocs.vendorLoc,
          destinationLocationId: subLocs.stockLoc,
          quantityPlanned: 30,
        }],
      }, ctx(ORG_SUB1));
      await flow.services.moveGroup.executeAction(inbound._id, 'confirm', {}, ctx(ORG_SUB1));
      await flow.services.moveGroup.executeAction(inbound._id, 'receive', {}, ctx(ORG_SUB1));

      // Verify balances
      expect(await getOnHand(ORG_HEAD, 'SKU-TRF', headLocs.stockLoc)).toBe(70);
      expect(await getOnHand(ORG_SUB1, 'SKU-TRF', subLocs.stockLoc)).toBe(30);
    });

    it('should conserve total stock across transfer', async () => {
      await seedStock(ORG_HEAD, 'SKU-CONS', 200, headLocs);

      // Transfer 80
      const outbound = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-CONS',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 80,
        }],
      }, ctx(ORG_HEAD));
      await flow.services.moveGroup.executeAction(outbound._id, 'confirm', {}, ctx(ORG_HEAD));
      await flow.services.moveGroup.executeAction(outbound._id, 'receive', {}, ctx(ORG_HEAD));

      const inbound = await flow.services.moveGroup.create({
        groupType: 'receipt',
        items: [{
          moveGroupId: '', operationType: 'receipt', skuRef: 'SKU-CONS',
          sourceLocationId: subLocs.vendorLoc,
          destinationLocationId: subLocs.stockLoc,
          quantityPlanned: 80,
        }],
      }, ctx(ORG_SUB1));
      await flow.services.moveGroup.executeAction(inbound._id, 'confirm', {}, ctx(ORG_SUB1));
      await flow.services.moveGroup.executeAction(inbound._id, 'receive', {}, ctx(ORG_SUB1));

      const headStock = await getOnHand(ORG_HEAD, 'SKU-CONS', headLocs.stockLoc);
      const subStock = await getOnHand(ORG_SUB1, 'SKU-CONS', subLocs.stockLoc);
      expect(headStock + subStock).toBe(200);
    });
  });

  // ── PROCUREMENT ──

  describe('Procurement', () => {
    it('should create, approve, and receive procurement order', async () => {
      const order = await flow.services.procurement.create({
        vendorRef: 'VENDOR-001',
        destinationNodeId: headLocs.nodeId,
        destinationLocationId: headLocs.stockLoc,
        items: [
          { skuRef: 'SKU-PURCH-A', quantity: 100, unitCost: 50 },
          { skuRef: 'SKU-PURCH-B', quantity: 50, unitCost: 80 },
        ],
      }, ctx());

      expect(order.status).toBe('draft');

      const approved = await flow.services.procurement.approve(order._id, ctx());
      expect(approved.status).toBe('approved');

      const received = await flow.services.procurement.receive(order._id, {
        lines: [
          { skuRef: 'SKU-PURCH-A', quantityReceived: 100 },
          { skuRef: 'SKU-PURCH-B', quantityReceived: 50 },
        ],
      }, ctx());

      expect(received.status).toBe('received');

      expect(await getOnHand(ORG_HEAD, 'SKU-PURCH-A', headLocs.stockLoc)).toBe(100);
      expect(await getOnHand(ORG_HEAD, 'SKU-PURCH-B', headLocs.stockLoc)).toBe(50);
    });

    it('should handle partial receipt', async () => {
      const order = await flow.services.procurement.create({
        vendorRef: 'VENDOR-002',
        destinationNodeId: headLocs.nodeId,
        destinationLocationId: headLocs.stockLoc,
        items: [{ skuRef: 'SKU-PARTIAL', quantity: 100, unitCost: 25 }],
      }, ctx());

      await flow.services.procurement.approve(order._id, ctx());

      const partial = await flow.services.procurement.receive(order._id, {
        lines: [{ skuRef: 'SKU-PARTIAL', quantityReceived: 60 }],
      }, ctx());
      expect(partial.status).toBe('partially_received');

      expect(await getOnHand(ORG_HEAD, 'SKU-PARTIAL', headLocs.stockLoc)).toBe(60);

      const full = await flow.services.procurement.receive(order._id, {
        lines: [{ skuRef: 'SKU-PARTIAL', quantityReceived: 40 }],
      }, ctx());
      expect(full.status).toBe('received');

      expect(await getOnHand(ORG_HEAD, 'SKU-PARTIAL', headLocs.stockLoc)).toBe(100);
    });
  });

  // ── POSTING / NEGATIVE STOCK GUARD ──

  describe('Posting & Negative Stock Guard', () => {
    it('should reject postMove when stock insufficient at non-negative location', async () => {
      await seedStock(ORG_HEAD, 'SKU-GUARD', 5, headLocs);

      const group = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-GUARD',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 50,
        }],
      }, ctx());

      const moves = await flow.repositories.move.findAll({ moveGroupId: group._id }, { organizationId: ctx().organizationId, lean: true });

      await expect(
        flow.services.posting.postMove(moves[0]._id, { quantityDone: 50 }, ctx()),
      ).rejects.toThrow(/negative stock/i);
    });

    it('should reject postMove with zero quantity', async () => {
      await seedStock(ORG_HEAD, 'SKU-ZERO', 100, headLocs);

      const group = await flow.services.moveGroup.create({
        groupType: 'transfer',
        items: [{
          moveGroupId: '', operationType: 'transfer', skuRef: 'SKU-ZERO',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 10,
        }],
      }, ctx());

      const moves = await flow.repositories.move.findAll({ moveGroupId: group._id }, { organizationId: ctx().organizationId, lean: true });

      // flow 0.3.0 validates postMove input via Zod
      // (`quantityDone: z.number().positive()`); a structural failure throws
      // the org-standard HttpError 400 ('Validation failed') carrying the
      // field under `validationErrors`, replacing the old /positive/ message.
      await expect(
        flow.services.posting.postMove(moves[0]._id, { quantityDone: 0 }, ctx()),
      ).rejects.toMatchObject({
        status: 400,
        validationErrors: expect.arrayContaining([
          expect.objectContaining({ error: expect.stringMatching(/quantityDone/i) }),
        ]),
      });
    });
  });

  // ── QUANT INVARIANT ──

  describe('Quant Invariant', () => {
    it('should maintain quantityAvailable = quantityOnHand - quantityReserved', async () => {
      await seedStock(ORG_HEAD, 'SKU-INV', 200, headLocs);

      // Reserve some
      await flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-INV',
        skuRef: 'SKU-INV', locationId: headLocs.stockLoc, quantity: 50,
      }, ctx());

      // Move some out
      const group = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-INV',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 30,
        }],
      }, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

      const avail = await flow.services.quant.getAvailability(
        { skuRef: 'SKU-INV', locationId: headLocs.stockLoc },
        ctx(),
      );

      expect(avail.quantityOnHand).toBe(170);
      expect(avail.quantityReserved).toBe(50);
      expect(avail.quantityAvailable).toBe(avail.quantityOnHand - avail.quantityReserved);
    });
  });

  // ── MULTI-ORG ISOLATION ──

  describe('Multi-Org Isolation', () => {
    it('should isolate stock between organizations', async () => {
      await seedStock(ORG_HEAD, 'SKU-ISO', 100, headLocs);
      await seedStock(ORG_SUB1, 'SKU-ISO', 50, subLocs);

      const headStock = await getOnHand(ORG_HEAD, 'SKU-ISO', headLocs.stockLoc);
      const subStock = await getOnHand(ORG_SUB1, 'SKU-ISO', subLocs.stockLoc);

      expect(headStock).toBe(100);
      expect(subStock).toBe(50);
      // Different orgs, same SKU, independent quantities
    });
  });

  // ── MOVE AUDIT TRAIL ──

  describe('Move Audit Trail', () => {
    it('should create StockMove records for every operation', async () => {
      await seedStock(ORG_HEAD, 'SKU-AUDIT', 100, headLocs);

      // The seedStock created moves. Query them.
      const result = await flow.repositories.move.getAll({ filters: {}, ...ctx() });
      const moves = result.data ?? result;
      expect(moves.length).toBeGreaterThan(0);

      // Every move should have required fields
      for (const move of moves) {
        expect(move.skuRef).toBe('SKU-AUDIT');
        expect(move.status).toBeDefined();
        expect(move.sourceLocationId).toBeDefined();
        expect(move.destinationLocationId).toBeDefined();
      }
    });
  });

  // ── FULL LIFECYCLE ──

  describe('Full Lifecycle: Procure → Stock → Reserve → Ship', () => {
    it('should complete full procurement-to-shipment cycle', async () => {
      // 1. Procure goods
      const po = await flow.services.procurement.create({
        vendorRef: 'VENDOR-FULL',
        destinationNodeId: headLocs.nodeId,
        destinationLocationId: headLocs.stockLoc,
        items: [{ skuRef: 'WIDGET', quantity: 500, unitCost: 10 }],
      }, ctx());
      await flow.services.procurement.approve(po._id, ctx());
      await flow.services.procurement.receive(po._id, {
        lines: [{ skuRef: 'WIDGET', quantityReceived: 500 }],
      }, ctx());

      expect(await getOnHand(ORG_HEAD, 'WIDGET', headLocs.stockLoc)).toBe(500);

      // 2. Reserve for order
      const reservation = await flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-FULL',
        skuRef: 'WIDGET', locationId: headLocs.stockLoc, quantity: 100,
      }, ctx());

      // 3. Ship (stock → customer)
      const shipment = await flow.services.moveGroup.create({
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: 'WIDGET',
          sourceLocationId: headLocs.stockLoc,
          destinationLocationId: headLocs.customerLoc,
          quantityPlanned: 100,
        }],
      }, ctx());
      await flow.services.moveGroup.executeAction(shipment._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(shipment._id, 'receive', {}, ctx());

      // 4. Consume reservation — consume() now decrements quantityReserved on the quant
      const consumed = await flow.services.reservation.consume(reservation._id, 100, ctx());
      expect(consumed.status).toBe('consumed');

      // 5. Verify final state
      const finalAvail = await flow.services.quant.getAvailability(
        { skuRef: 'WIDGET', locationId: headLocs.stockLoc },
        ctx(),
      );
      expect(finalAvail.quantityOnHand).toBe(400);
      // After shipment: on-hand = 400
      // After consume: reserved released → reserved = 0
      // Available = onHand - reserved = 400 - 0 = 400
      expect(finalAvail.quantityAvailable).toBe(400);
    });
  });
});
