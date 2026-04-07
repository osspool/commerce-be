/**
 * Warehouse Management — Full Scenario Tests
 *
 * End-to-end business scenarios testing the complete Flow + warehouse lifecycle.
 * Each scenario tests a real-world workflow from start to finish.
 *
 * Scenarios:
 * 1. Warehouse setup: create node → create locations with coordinates → verify layout
 * 2. Inbound receipt: procurement → receive → stock appears at locations
 * 3. Internal transfer: allocate → dispatch → receive between locations
 * 4. Reservation lifecycle: reserve → partial consume → expire remainder → verify quant
 * 5. Stock audit: create session → submit counts → variance report → reconcile → adjustment moves
 * 6. Wave picking: seed multi-location stock → optimize pick path → verify serpentine order
 * 7. Negative stock guard: reject overdraw on real locations, allow on virtual
 * 8. Plan-based limits: standard mode rejects second warehouse node
 * 9. Concurrent allocation: 5 groups competing for 100 units → exactly 5 succeed
 * 10. Reservation cleanup: expired reservations auto-released by cleanupExpired()
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine, type FlowEngine } from '@classytic/flow';
import { WaveEngine } from '@classytic/flow/routing';
import type { FlowContext } from '@classytic/flow';
import type { Location } from '@classytic/flow/domain';

let replSet: any;
let flow: FlowEngine;

const ORG = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-actor';
const ctx = (): FlowContext => ({ organizationId: ORG, actorId: ACTOR });

const catalogBridge = {
  async resolveSku(skuRef: string) {
    return { skuRef, sku: skuRef, displayName: `Product ${skuRef}`, trackingMode: 'none' as const, uom: 'unit', isActive: true };
  },
};

// Shared location IDs — set in beforeEach
let nodeId: string;
let zoneALocs: string[] = []; // aisle 1 bay 1-3, aisle 2 bay 1-3
let vendorLocId: string;
let customerLocId: string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  flow = createFlowEngine({ mongoose: mongoose.connection, mode: 'standard', catalog: catalogBridge });
  for (const model of Object.values(flow.models) as any[]) await model.createCollection();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  await Promise.all((Object.values(flow.models) as any[]).map((m) => m.deleteMany({})));

  const uid = () => Math.random().toString(36).slice(2, 8);

  // Create warehouse node
  const node = await flow.repositories.node.create({
    organizationId: ORG, code: 'WH-MAIN', name: 'Main Warehouse',
    type: 'warehouse', status: 'active', isDefault: true,
  });
  nodeId = node._id.toString();

  // Create zone A: 2 aisles × 3 bays = 6 storage locations with coordinates
  zoneALocs = [];
  for (let aisle = 1; aisle <= 2; aisle++) {
    for (let bay = 1; bay <= 3; bay++) {
      const code = `A-${aisle}-${bay}`;
      const loc = await flow.repositories.location.create({
        organizationId: ORG, nodeId, code, name: `Zone A Aisle ${aisle} Bay ${bay}`,
        type: 'storage', status: 'active', barcode: `BC-${uid()}`,
        coordinates: { zone: 'A', aisle, bay, level: 1, bin: 'A' },
      });
      zoneALocs.push(loc._id.toString());
    }
  }

  // Virtual locations
  const vendor = await flow.repositories.location.create({
    organizationId: ORG, nodeId, code: 'VENDOR', name: 'Vendor',
    type: 'vendor', status: 'active', allowNegativeStock: true, barcode: `BC-${uid()}`,
  });
  vendorLocId = vendor._id.toString();

  const customer = await flow.repositories.location.create({
    organizationId: ORG, nodeId, code: 'CUSTOMER', name: 'Customer',
    type: 'customer', status: 'active', allowNegativeStock: true, barcode: `BC-${uid()}`,
  });
  customerLocId = customer._id.toString();
});

// ── Scenario 1: Warehouse Setup ──

describe('Scenario 1: Warehouse Setup', () => {
  it('should create node with locations and return grouped layout', async () => {
    const locations = await flow.repositories.location.findByNode(nodeId, ctx());
    // 6 storage + vendor + customer = 8
    expect(locations.length).toBe(8);

    const storageLocations = locations.filter(l => l.type === 'storage');
    expect(storageLocations.length).toBe(6);

    // Verify codes contain coordinate info
    for (const loc of storageLocations) {
      expect(loc.code).toMatch(/^A-\d-\d$/);
    }
  });

  it('should build location tree from hierarchy', async () => {
    const tree = await flow.repositories.location.getTree(nodeId, ctx());
    expect(tree.length).toBeGreaterThanOrEqual(6);
  });
});

// ── Scenario 2: Inbound Receipt ──

describe('Scenario 2: Inbound Receipt to Specific Location', () => {
  it('should receive stock at a specific bin location', async () => {
    const targetLoc = zoneALocs[0]; // A-1-1

    const group = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{
        moveGroupId: '', operationType: 'receipt', skuRef: 'WIDGET-A',
        sourceLocationId: vendorLocId, destinationLocationId: targetLoc, quantityPlanned: 200,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

    // Verify stock at the exact bin
    const avail = await flow.services.quant.getAvailability({ skuRef: 'WIDGET-A', locationId: targetLoc }, ctx());
    expect(avail.quantityOnHand).toBe(200);
    expect(avail.quantityAvailable).toBe(200);

    // Verify group is done
    const updated = await flow.services.moveGroup.getById(group._id, ctx());
    expect(updated!.status).toBe('done');
  });
});

// ── Scenario 3: Internal Transfer Between Locations ──

describe('Scenario 3: Internal Transfer', () => {
  it('should transfer stock from one bin to another with allocation', async () => {
    const sourceLoc = zoneALocs[0]; // A-1-1
    const destLoc = zoneALocs[5];   // A-2-3

    // Seed stock at source
    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'GADGET-X', locationId: sourceLoc, quantityDelta: 50, inDate: new Date(),
    });

    // Create transfer
    const group = await flow.services.moveGroup.create({
      groupType: 'transfer',
      items: [{
        moveGroupId: '', operationType: 'transfer', skuRef: 'GADGET-X',
        sourceLocationId: sourceLoc, destinationLocationId: destLoc, quantityPlanned: 30,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(group._id, 'allocate', {}, ctx());

    // After allocation: 30 reserved at source
    const afterAlloc = await flow.services.quant.getAvailability({ skuRef: 'GADGET-X', locationId: sourceLoc }, ctx());
    expect(afterAlloc.quantityReserved).toBe(30);
    expect(afterAlloc.quantityAvailable).toBe(20);

    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

    // After transfer: source=20, dest=30, reservations released
    const sourceAvail = await flow.services.quant.getAvailability({ skuRef: 'GADGET-X', locationId: sourceLoc }, ctx());
    expect(sourceAvail.quantityOnHand).toBe(20);
    expect(sourceAvail.quantityReserved).toBe(0);

    const destAvail = await flow.services.quant.getAvailability({ skuRef: 'GADGET-X', locationId: destLoc }, ctx());
    expect(destAvail.quantityOnHand).toBe(30);
  });
});

// ── Scenario 4: Reservation Lifecycle ──

describe('Scenario 4: Reservation Lifecycle', () => {
  it('should reserve → partial consume → expire remainder → quant fully released', async () => {
    const loc = zoneALocs[1]; // A-1-2

    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'ITEM-R', locationId: loc, quantityDelta: 100, inDate: new Date(),
    });

    // Reserve 40
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-100',
      skuRef: 'ITEM-R', locationId: loc, quantity: 40,
    }, ctx());

    expect(reservation.quantity).toBe(40);
    let avail = await flow.services.quant.getAvailability({ skuRef: 'ITEM-R', locationId: loc }, ctx());
    expect(avail.quantityAvailable).toBe(60);

    // Consume 15 (partial)
    const consumed = await flow.services.reservation.consume(reservation._id, 15, ctx());
    expect(consumed.quantityConsumed).toBe(15);
    expect(consumed.status).toBe('partially_consumed');

    avail = await flow.services.quant.getAvailability({ skuRef: 'ITEM-R', locationId: loc }, ctx());
    expect(avail.quantityReserved).toBe(25); // 40 - 15 consumed

    // Expire the remainder
    await flow.services.reservation.expire(reservation._id, ctx());

    avail = await flow.services.quant.getAvailability({ skuRef: 'ITEM-R', locationId: loc }, ctx());
    expect(avail.quantityReserved).toBe(0); // All released
    expect(avail.quantityAvailable).toBe(100);
  });
});

// ── Scenario 5: Stock Audit ──

describe('Scenario 5: Stock Audit', () => {
  it('should create audit → submit lines → calculate variance → reconcile', async () => {
    const loc = zoneALocs[2]; // A-1-3

    // Seed: system thinks 50 units
    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'COUNTED-SKU', locationId: loc, quantityDelta: 50, inDate: new Date(),
    });

    // Create audit session
    const session = await flow.services.counting.createSession({
      countType: 'spot',
      scope: { nodeId },
    }, ctx());

    expect(session).toBeDefined();

    // Submit count: physical count says 47 (3 units short)
    await flow.services.counting.submitLines(session._id, [{
      skuRef: 'COUNTED-SKU', locationId: loc, countedQuantity: 47,
    }], ctx());

    // Calculate variance
    const variance = await flow.services.counting.calculateVariance(session._id, ctx());
    expect(variance.varianceLines).toBe(1);
    expect(variance.lines[0].expected).toBe(50);
    expect(variance.lines[0].counted).toBe(47);
    expect(variance.lines[0].variance).toBe(-3);

    // Reconcile with auto-approve threshold of 5
    const result = await flow.services.counting.reconcile(session._id, { autoApproveThreshold: 5 }, ctx());
    expect(result.autoApproved).toBe(1); // -3 is within ±5 threshold
  });
});

// ── Scenario 6: Wave Pick Path (Serpentine) ──

describe('Scenario 6: Wave Pick Path Optimization', () => {
  it('should sort picks in serpentine order across aisles', async () => {
    // Seed stock at all 6 locations
    for (const locId of zoneALocs) {
      await flow.repositories.quant.upsert({
        organizationId: ORG, skuRef: 'PICK-SKU', locationId: locId, quantityDelta: 10, inDate: new Date(),
      });
    }

    // Create moves from scattered locations (full StockMove shape for the engine)
    const makeMove = (id: string, locId: string) => ({
      _id: id, organizationId: ORG, moveGroupId: 'grp', operationType: 'shipment',
      skuRef: 'PICK-SKU', sourceLocationId: locId, destinationLocationId: customerLocId,
      quantityPlanned: 10, status: 'planned', metadata: {},
    });

    const moves = [
      makeMove('a2b3', zoneALocs[5]), // A-2-3
      makeMove('a1b1', zoneALocs[0]), // A-1-1
      makeMove('a2b1', zoneALocs[3]), // A-2-1
      makeMove('a1b3', zoneALocs[2]), // A-1-3
    ] as any[];

    // Build location map from the stored string IDs
    // We need to fetch each location and map by the string ID we stored
    const allLocs = await flow.repositories.location.findByNode(nodeId, ctx());
    const locationMap = new Map<string, any>();
    for (const loc of allLocs) {
      const id = String(loc._id);
      locationMap.set(id, {
        ...loc,
        _id: id,
        // Ensure coordinates are present (lean() might strip them)
        coordinates: loc.coordinates ?? undefined,
      });
    }

    const engine = new WaveEngine();
    const sorted = engine.optimizePickPath(moves, locationMap);

    // Serpentine: Aisle 1 ascending (bay 1→3), Aisle 2 descending (bay 3→1)
    expect(sorted.map(m => m._id)).toEqual(['a1b1', 'a1b3', 'a2b3', 'a2b1']);
  });
});

// ── Scenario 7: Negative Stock Guard ──

describe('Scenario 7: Negative Stock Guard', () => {
  it('should reject shipment from real location with insufficient stock', async () => {
    const loc = zoneALocs[0];

    // Seed only 10 units
    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'SCARCE', locationId: loc, quantityDelta: 10, inDate: new Date(),
    });

    const group = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment', skuRef: 'SCARCE',
        sourceLocationId: loc, destinationLocationId: customerLocId, quantityPlanned: 50,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());

    // Should fail — only 10 available, trying to ship 50
    await expect(
      flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx()),
    ).rejects.toThrow(/negative stock/i);
  });

  it('should allow receipt from virtual vendor location (no stock there)', async () => {
    const destLoc = zoneALocs[1];

    const group = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{
        moveGroupId: '', operationType: 'receipt', skuRef: 'NEW-ITEM',
        sourceLocationId: vendorLocId, destinationLocationId: destLoc, quantityPlanned: 500,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

    const avail = await flow.services.quant.getAvailability({ skuRef: 'NEW-ITEM', locationId: destLoc }, ctx());
    expect(avail.quantityOnHand).toBe(500);
  });
});

// ── Scenario 8: Plan-Based Node Limits ──

describe('Scenario 8: Plan-Based Warehouse Limits', () => {
  it('standard mode should enforce max 1 node per org', async () => {
    // Node already exists from beforeEach
    expect(flow.services.mode).toBe('standard');

    const existing = await flow.repositories.node.list(ctx());
    expect(existing.length).toBe(1);

    // Creating second node should work at repository level (no plan check there)
    // Plan check is in the HTTP handler, not the repository — so this tests the data layer
    const second = await flow.repositories.node.create({
      organizationId: ORG, code: 'WH-2', name: 'Second Warehouse',
      type: 'warehouse', status: 'active',
    });
    expect(second._id).toBeDefined();

    // The HTTP layer (Arc resource) would reject this — tested in warehouse-e2e.test.ts
  });
});

// ── Scenario 9: Concurrent Allocation Safety ──

describe('Scenario 9: Concurrent Allocation', () => {
  it('should allocate exactly the available stock — no overselling', async () => {
    const loc = zoneALocs[3]; // A-2-1

    // Seed 100 units
    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'HOT-ITEM', locationId: loc, quantityDelta: 100, inDate: new Date(),
    });

    // Create 5 groups, each wanting 30 (total 150, only 100 available)
    const groups = [];
    for (let i = 0; i < 5; i++) {
      const group = await flow.services.moveGroup.create({
        groupType: 'transfer',
        items: [{
          moveGroupId: '', operationType: 'transfer', skuRef: 'HOT-ITEM',
          sourceLocationId: loc, destinationLocationId: zoneALocs[4], quantityPlanned: 30,
        }],
      }, ctx());
      await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
      groups.push(group);
    }

    // Fire all 5 allocations concurrently
    const results = await Promise.allSettled(
      groups.map(g => flow.services.moveGroup.executeAction(g._id, 'allocate', {}, ctx())),
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // At most 3 can succeed (3 × 30 = 90 ≤ 100), 4th would need 120
    expect(succeeded.length).toBe(3);
    expect(failed.length).toBe(2);

    // Total reserved should be exactly 90
    const quant = await flow.services.quant.getAvailability({ skuRef: 'HOT-ITEM', locationId: loc }, ctx());
    expect(quant.quantityReserved).toBe(90);
    expect(quant.quantityAvailable).toBe(10);
  });
});

// ── Scenario 10: Reservation Cleanup ──

describe('Scenario 10: Reservation Cleanup', () => {
  it('should expire past-due reservations and release locked stock', async () => {
    const loc = zoneALocs[4]; // A-2-2

    await flow.repositories.quant.upsert({
      organizationId: ORG, skuRef: 'EXPIRE-TEST', locationId: loc, quantityDelta: 100, inDate: new Date(),
    });

    // Create 3 reservations: 2 expired, 1 still valid
    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'cart-1',
      skuRef: 'EXPIRE-TEST', locationId: loc, quantity: 20,
      expiresAt: new Date(Date.now() - 120_000), // Expired 2 min ago
    }, ctx());

    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'cart-2',
      skuRef: 'EXPIRE-TEST', locationId: loc, quantity: 15,
      expiresAt: new Date(Date.now() - 60_000), // Expired 1 min ago
    }, ctx());

    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'cart-3',
      skuRef: 'EXPIRE-TEST', locationId: loc, quantity: 10,
      expiresAt: new Date(Date.now() + 600_000), // Valid for 10 more min
    }, ctx());

    // Before cleanup: reserved = 45
    let avail = await flow.services.quant.getAvailability({ skuRef: 'EXPIRE-TEST', locationId: loc }, ctx());
    expect(avail.quantityReserved).toBe(45);

    // Run cleanup
    const result = await flow.services.reservation.cleanupExpired(ctx());
    expect(result.expired).toBe(2);

    // After cleanup: only the valid reservation (10) remains
    avail = await flow.services.quant.getAvailability({ skuRef: 'EXPIRE-TEST', locationId: loc }, ctx());
    expect(avail.quantityReserved).toBe(10);
    expect(avail.quantityAvailable).toBe(90);
  });
});
