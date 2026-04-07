/**
 * Product ↔ Stock Lifecycle E2E Tests
 *
 * Tests the complete product-to-stock relationship through Flow:
 *
 * 1. Simple shop (no warehouse): bootstrap → receipt → availability → reserve → ship
 * 2. Variant product: multiple SKU refs for same product
 * 3. Stock adjustment: manual correction via adjustment MoveGroup
 * 4. Order lifecycle: reserve at checkout → commit at fulfillment → release on cancel
 * 5. Multi-branch isolation: stock at branch A invisible to branch B
 * 6. Low stock detection: quant drops below threshold
 * 7. Product without stock: new product has 0 availability (no quant needed)
 * 8. Audit after operations: quant matches move history
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine, type FlowEngine } from '@classytic/flow';
import type { FlowContext } from '@classytic/flow';

let replSet: any;
let flow: FlowEngine;

const BRANCH_A = new mongoose.Types.ObjectId().toString();
const BRANCH_B = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-user';

function ctx(orgId = BRANCH_A): FlowContext {
  return { organizationId: orgId, actorId: ACTOR };
}

// Simulate be-prod's skuRefFromProduct
function skuRef(productId: string, variantSku?: string | null): string {
  return variantSku || productId;
}

// Locations per branch (matches location-bootstrap.ts)
const locs: Record<string, { stock: string; vendor: string; customer: string; adjustment: string }> = {};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());

  flow = createFlowEngine({ mongoose: mongoose.connection, mode: 'standard', catalog: {
    async resolveSku(ref: string) {
      return { skuRef: ref, sku: ref, displayName: `Product ${ref}`, trackingMode: 'none' as const, uom: 'unit', isActive: true };
    },
  }});

  for (const model of Object.values(flow.models) as any[]) await model.createCollection();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

async function bootstrapBranch(orgId: string) {
  const uid = () => Math.random().toString(36).slice(2, 8);
  let node = await flow.repositories.node.findDefault({ organizationId: orgId, actorId: 'system' });
  if (!node) {
    node = await flow.repositories.node.create({
      organizationId: orgId, code: 'DEFAULT', name: 'Default', type: 'warehouse', status: 'active', isDefault: true,
    });
  }
  const nodeId = String(node._id);

  const locDefs = [
    { code: 'stock', name: 'Stock', type: 'storage' as const, neg: false },
    { code: 'vendor', name: 'Vendor', type: 'vendor' as const, neg: true },
    { code: 'customer', name: 'Customer', type: 'customer' as const, neg: true },
    { code: 'adjustment', name: 'Adjustment', type: 'inventory_loss' as const, neg: true },
  ];

  const result: Record<string, string> = {};
  for (const def of locDefs) {
    let loc = await flow.repositories.location.findByCode(def.code, nodeId, { organizationId: orgId, actorId: 'system' });
    if (!loc) {
      loc = await flow.repositories.location.create({
        organizationId: orgId, nodeId, code: def.code, name: def.name,
        type: def.type, status: 'active', allowNegativeStock: def.neg,
        allowReservations: def.code === 'stock', barcode: `BC-${uid()}`,
      });
    }
    result[def.code] = String(loc._id);
  }
  return result;
}

beforeEach(async () => {
  await Promise.all((Object.values(flow.models) as any[]).map((m) => m.deleteMany({})));
  locs[BRANCH_A] = await bootstrapBranch(BRANCH_A);
  locs[BRANCH_B] = await bootstrapBranch(BRANCH_B);
});

// ── 1. Simple Shop: No Warehouse, Just Stock ──

describe('1. Simple Shop Lifecycle', () => {
  const PRODUCT_ID = 'prod-tshirt-001';

  it('should go from zero stock → receipt → available → reserve → ship', async () => {
    const sku = skuRef(PRODUCT_ID);

    // Start: product has zero stock
    const initial = await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(),
    );
    expect(initial.quantityOnHand).toBe(0);
    expect(initial.quantityAvailable).toBe(0);

    // Step 1: Receive 100 units from vendor
    const receipt = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{
        moveGroupId: '', operationType: 'receipt', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].vendor,
        destinationLocationId: locs[BRANCH_A].stock,
        quantityPlanned: 100,
      }],
    }, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'receive', {}, ctx());

    // Verify: 100 on hand
    const afterReceipt = await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(),
    );
    expect(afterReceipt.quantityOnHand).toBe(100);
    expect(afterReceipt.quantityAvailable).toBe(100);

    // Step 2: Customer places order — reserve 3 units
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-001',
      skuRef: sku, locationId: locs[BRANCH_A].stock, quantity: 3,
    }, ctx());

    const afterReserve = await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(),
    );
    expect(afterReserve.quantityOnHand).toBe(100);
    expect(afterReserve.quantityReserved).toBe(3);
    expect(afterReserve.quantityAvailable).toBe(97);

    // Step 3: Fulfill order — ship 3 units to customer
    const shipment = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].stock,
        destinationLocationId: locs[BRANCH_A].customer,
        quantityPlanned: 3,
      }],
    }, ctx());
    await flow.services.moveGroup.executeAction(shipment._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(shipment._id, 'receive', {}, ctx());

    // Consume + release reservation
    await flow.services.reservation.consume(reservation._id, 3, ctx());

    // Final state: 97 on hand, 0 reserved
    const final = await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(),
    );
    expect(final.quantityOnHand).toBe(97);
    expect(final.quantityReserved).toBe(0);
    expect(final.quantityAvailable).toBe(97);
  });
});

// ── 2. Variant Products ──

describe('2. Variant Product Stock', () => {
  const PRODUCT_ID = 'prod-hoodie-001';

  it('should track stock per variant SKU independently', async () => {
    const skuM = skuRef(PRODUCT_ID, 'HOODIE-M');
    const skuL = skuRef(PRODUCT_ID, 'HOODIE-L');

    // Receive M=50, L=30
    for (const [sku, qty] of [[skuM, 50], [skuL, 30]] as const) {
      const g = await flow.services.moveGroup.create({
        groupType: 'receipt',
        items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
          sourceLocationId: locs[BRANCH_A].vendor, destinationLocationId: locs[BRANCH_A].stock,
          quantityPlanned: qty }],
      }, ctx());
      await flow.services.moveGroup.executeAction(g._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(g._id, 'receive', {}, ctx());
    }

    const availM = await flow.services.quant.getAvailability({ skuRef: skuM, locationId: locs[BRANCH_A].stock }, ctx());
    const availL = await flow.services.quant.getAvailability({ skuRef: skuL, locationId: locs[BRANCH_A].stock }, ctx());

    expect(availM.quantityOnHand).toBe(50);
    expect(availL.quantityOnHand).toBe(30);

    // Selling 10 of M doesn't affect L
    const ship = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: skuM,
        sourceLocationId: locs[BRANCH_A].stock, destinationLocationId: locs[BRANCH_A].customer,
        quantityPlanned: 10 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'receive', {}, ctx());

    expect((await flow.services.quant.getAvailability({ skuRef: skuM, locationId: locs[BRANCH_A].stock }, ctx())).quantityOnHand).toBe(40);
    expect((await flow.services.quant.getAvailability({ skuRef: skuL, locationId: locs[BRANCH_A].stock }, ctx())).quantityOnHand).toBe(30);
  });
});

// ── 3. Stock Adjustment ──

describe('3. Stock Adjustment', () => {
  it('should correct stock via adjustment MoveGroup', async () => {
    const sku = 'prod-damaged-001';

    // Seed 100
    await flow.repositories.quant.upsert({
      organizationId: BRANCH_A, skuRef: sku, locationId: locs[BRANCH_A].stock,
      quantityDelta: 100, inDate: new Date(),
    });

    // Adjust: remove 5 damaged units (stock → adjustment location)
    const adj = await flow.services.moveGroup.create({
      groupType: 'adjustment',
      items: [{ moveGroupId: '', operationType: 'adjustment', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].stock,
        destinationLocationId: locs[BRANCH_A].adjustment,
        quantityPlanned: 5 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(adj._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(adj._id, 'receive', {}, ctx());

    const avail = await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx());
    expect(avail.quantityOnHand).toBe(95);
  });
});

// ── 4. Order Cancel: Release Reservation ──

describe('4. Order Cancellation Releases Stock', () => {
  it('should release reserved stock when order is cancelled', async () => {
    const sku = 'prod-cancel-test';

    await flow.repositories.quant.upsert({
      organizationId: BRANCH_A, skuRef: sku, locationId: locs[BRANCH_A].stock,
      quantityDelta: 50, inDate: new Date(),
    });

    // Reserve for order
    const res = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-CANCEL',
      skuRef: sku, locationId: locs[BRANCH_A].stock, quantity: 20,
    }, ctx());

    expect((await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx())).quantityAvailable).toBe(30);

    // Cancel order → release reservation
    await flow.services.reservation.release(res._id, ctx());

    expect((await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx())).quantityAvailable).toBe(50);
  });
});

// ── 5. Multi-Branch Isolation ──

describe('5. Multi-Branch Stock Isolation', () => {
  it('should isolate stock between branches', async () => {
    const sku = 'prod-shared-sku';

    // Branch A: 100 units
    await flow.repositories.quant.upsert({
      organizationId: BRANCH_A, skuRef: sku, locationId: locs[BRANCH_A].stock,
      quantityDelta: 100, inDate: new Date(),
    });

    // Branch B: 25 units
    await flow.repositories.quant.upsert({
      organizationId: BRANCH_B, skuRef: sku, locationId: locs[BRANCH_B].stock,
      quantityDelta: 25, inDate: new Date(),
    });

    const availA = await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(BRANCH_A));
    const availB = await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_B].stock }, ctx(BRANCH_B));

    expect(availA.quantityOnHand).toBe(100);
    expect(availB.quantityOnHand).toBe(25);

    // Selling from A doesn't affect B
    const ship = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].stock, destinationLocationId: locs[BRANCH_A].customer,
        quantityPlanned: 90 }],
    }, ctx(BRANCH_A));
    await flow.services.moveGroup.executeAction(ship._id, 'confirm', {}, ctx(BRANCH_A));
    await flow.services.moveGroup.executeAction(ship._id, 'receive', {}, ctx(BRANCH_A));

    expect((await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_A].stock }, ctx(BRANCH_A))).quantityOnHand).toBe(10);
    expect((await flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[BRANCH_B].stock }, ctx(BRANCH_B))).quantityOnHand).toBe(25);
  });
});

// ── 6. New Product: Zero Stock ──

describe('6. New Product Has Zero Stock', () => {
  it('should return zero availability for product with no quant', async () => {
    const avail = await flow.services.quant.getAvailability(
      { skuRef: 'brand-new-product-never-stocked', locationId: locs[BRANCH_A].stock },
      ctx(),
    );

    expect(avail.quantityOnHand).toBe(0);
    expect(avail.quantityReserved).toBe(0);
    expect(avail.quantityAvailable).toBe(0);
  });
});

// ── 7. Negative Stock Prevention ──

describe('7. Cannot Oversell', () => {
  it('should reject reservation exceeding available stock', async () => {
    const sku = 'prod-limited';

    await flow.repositories.quant.upsert({
      organizationId: BRANCH_A, skuRef: sku, locationId: locs[BRANCH_A].stock,
      quantityDelta: 5, inDate: new Date(),
    });

    await expect(
      flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-OVER',
        skuRef: sku, locationId: locs[BRANCH_A].stock, quantity: 10,
      }, ctx()),
    ).rejects.toThrow(/insufficient/i);
  });
});

// ── 8. Quant is Source of Truth (product.quantity is a cache) ──

describe('8. Quant Source of Truth', () => {
  it('quant reflects actual stock after receipt + shipment + adjustment', async () => {
    const sku = 'prod-truth-test';
    const stockLoc = locs[BRANCH_A].stock;

    // Receipt: +100
    const receipt = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].vendor, destinationLocationId: stockLoc, quantityPlanned: 100 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'receive', {}, ctx());

    // Shipment: -30
    const ship = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: sku,
        sourceLocationId: stockLoc, destinationLocationId: locs[BRANCH_A].customer, quantityPlanned: 30 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'receive', {}, ctx());

    // Adjustment: -5 (damaged)
    const adj = await flow.services.moveGroup.create({
      groupType: 'adjustment',
      items: [{ moveGroupId: '', operationType: 'adjustment', skuRef: sku,
        sourceLocationId: stockLoc, destinationLocationId: locs[BRANCH_A].adjustment, quantityPlanned: 5 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(adj._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(adj._id, 'receive', {}, ctx());

    // Quant should be 100 - 30 - 5 = 65
    const avail = await flow.services.quant.getAvailability({ skuRef: sku, locationId: stockLoc }, ctx());
    expect(avail.quantityOnHand).toBe(65);
    expect(avail.quantityAvailable).toBe(65);

    // This is what syncProductQuantityFromQuant() would write to product.quantity
    // In production: event handler fires → reads quant → updates product.quantity = 65
  });
});

// ── 9. Full Audit Trail ──

describe('9. Move Audit Trail', () => {
  it('should create StockMove records for every operation', async () => {
    const sku = 'prod-audited';

    // Receipt
    const g = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
        sourceLocationId: locs[BRANCH_A].vendor, destinationLocationId: locs[BRANCH_A].stock,
        quantityPlanned: 50 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(g._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(g._id, 'receive', {}, ctx());

    // Query moves
    const moves = await flow.repositories.move.findMany(
      { skuRef: sku },
      ctx(),
    );

    expect(moves.length).toBe(1);
    expect(moves[0].operationType).toBe('receipt');
    expect(moves[0].quantityDone).toBe(50);
    expect(moves[0].status).toBe('done');
  });
});
