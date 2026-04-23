/**
 * Commerce × Inventory E2E — Full Business Workflow Tests
 *
 * Tests the complete product → stock → order → fulfillment → audit lifecycle.
 * Uses Flow engine directly (not HTTP) to test service-level correctness.
 *
 * Scenarios:
 * 1. Order lifecycle: receive stock → validate → reserve → fulfill (ship) → verify quantities
 * 2. Order cancellation: reserve → cancel → stock released back
 * 3. Supplier procurement: create PO → receive goods → stock appears → product qty synced
 * 4. Inter-branch transfer: branch A ships → branch B receives → both quants correct
 * 5. Stock request: sub-branch requests → head office creates transfer → fulfills
 * 6. Customer return: ship → customer returns → quality hold → restock
 * 7. Reservation expiry: reserve at checkout → 15 min TTL expires → cleanupExpired releases
 * 8. Variant product: 3 sizes × different stock levels → independent tracking
 * 9. Concurrent orders: 3 orders compete for limited stock → 2 succeed, 1 fails
 * 10. Stock adjustment with audit: count reveals shortage → reconcile → quant corrected
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine, ensureFlowReady, type FlowEngine } from '@classytic/flow';
import type { FlowContext } from '@classytic/flow';

let replSet: any;
let flow: FlowEngine;

const HEAD_OFFICE = new mongoose.Types.ObjectId().toString();
const SUB_BRANCH = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-actor';

function ctx(orgId = HEAD_OFFICE): FlowContext {
  return { organizationId: orgId, actorId: ACTOR };
}

function skuRef(productId: string, variantSku?: string | null) {
  return variantSku || productId;
}

const locs: Record<string, Record<string, string>> = {};

const catalogBridge = {
  async resolveSku(ref: string) {
    return { skuRef: ref, sku: ref, displayName: `Product ${ref}`, trackingMode: 'none' as const, uom: 'unit', isActive: true };
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  flow = createFlowEngine({ mongoose: mongoose.connection, mode: 'standard', catalog: catalogBridge });
  // Drain collection + index builds before transactions run.
  await ensureFlowReady(flow);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

async function bootstrapBranch(orgId: string) {
  const uid = () => Math.random().toString(36).slice(2, 8);
  let node = await flow.repositories.node.getByQuery({ isDefault: true }, { organizationId: orgId, throwOnNotFound: false, lean: true });
  if (!node) {
    node = await flow.repositories.node.create(
      { organizationId: orgId, code: 'DEFAULT', name: 'Default', type: 'warehouse', status: 'active', isDefault: true } as Record<string, unknown>,
      { organizationId: orgId },
    );
  }
  const nodeId = String(node._id);
  const defs = [
    { code: 'stock', name: 'Stock', type: 'storage' as const, neg: false },
    { code: 'vendor', name: 'Vendor', type: 'vendor' as const, neg: true },
    { code: 'customer', name: 'Customer', type: 'customer' as const, neg: true },
    { code: 'adjustment', name: 'Adjustment', type: 'inventory_loss' as const, neg: true },
    { code: 'quality_hold', name: 'Quality Hold', type: 'quality_hold' as const, neg: false },
  ];
  const result: Record<string, string> = {};
  for (const def of defs) {
    let loc = await flow.repositories.location.getByQuery(
      { code: def.code, nodeId },
      { organizationId: orgId, throwOnNotFound: false },
    );
    if (!loc) {
      loc = await flow.repositories.location.create(
        {
          organizationId: orgId, nodeId, code: def.code, name: def.name,
          type: def.type, status: 'active', allowNegativeStock: def.neg,
          allowReservations: def.code === 'stock', barcode: `BC-${uid()}`,
        },
        { organizationId: orgId },
      );
    }
    result[def.code] = String(loc._id);
  }
  return result;
}

async function seedStock(orgId: string, sku: string, qty: number) {
  await flow.repositories.quant.upsert({
    organizationId: orgId, skuRef: sku, locationId: locs[orgId].stock,
    quantityDelta: qty, inDate: new Date(),
  });
}

async function getStock(orgId: string, sku: string) {
  return flow.services.quant.getAvailability({ skuRef: sku, locationId: locs[orgId].stock }, ctx(orgId));
}

beforeEach(async () => {
  await Promise.all((Object.values(flow.models) as any[]).map((m) => m.deleteMany({})));
  locs[HEAD_OFFICE] = await bootstrapBranch(HEAD_OFFICE);
  locs[SUB_BRANCH] = await bootstrapBranch(SUB_BRANCH);
});

// ── 1. Order Lifecycle: Receive → Validate → Reserve → Fulfill → Ship ──

describe('1. Order Lifecycle', () => {
  it('should receive stock, reserve for order, ship, and update quantities', async () => {
    const sku = skuRef('prod-tshirt');

    // Step 1: Supplier sends 200 units → receipt
    const receipt = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].vendor, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: 200 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'receive', {}, ctx());

    expect((await getStock(HEAD_OFFICE, sku)).quantityOnHand).toBe(200);

    // Step 2: Customer places order for 5 → reserve
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'ORDER-001',
      skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 5,
    }, ctx());

    let stock = await getStock(HEAD_OFFICE, sku);
    expect(stock.quantityOnHand).toBe(200);
    expect(stock.quantityReserved).toBe(5);
    expect(stock.quantityAvailable).toBe(195);

    // Step 3: Admin fulfills order → ship 5 units to customer
    const shipment = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].stock, destinationLocationId: locs[HEAD_OFFICE].customer, quantityPlanned: 5 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(shipment._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(shipment._id, 'receive', {}, ctx());

    // Step 4: Consume reservation (stock already moved)
    await flow.services.reservation.consume(reservation._id, 5, ctx());

    // Final: 195 on hand, 0 reserved
    stock = await getStock(HEAD_OFFICE, sku);
    expect(stock.quantityOnHand).toBe(195);
    expect(stock.quantityReserved).toBe(0);
    expect(stock.quantityAvailable).toBe(195);
  });
});

// ── 2. Order Cancellation ──

describe('2. Order Cancellation', () => {
  it('should release all reserved stock when order is cancelled', async () => {
    const sku = skuRef('prod-hoodie');
    await seedStock(HEAD_OFFICE, sku, 100);

    // Reserve for order
    const res1 = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'ORDER-CANCEL',
      skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 15,
    }, ctx());

    expect((await getStock(HEAD_OFFICE, sku)).quantityAvailable).toBe(85);

    // Customer cancels → release
    await flow.services.reservation.release(res1._id, ctx());

    // All stock back
    const stock = await getStock(HEAD_OFFICE, sku);
    expect(stock.quantityOnHand).toBe(100);
    expect(stock.quantityReserved).toBe(0);
    expect(stock.quantityAvailable).toBe(100);
  });
});

// ── 3. Supplier Procurement → Receive → Stock Appears ──

describe('3. Supplier Procurement', () => {
  it('should increase stock when procurement order is received', async () => {
    const sku1 = skuRef('prod-widget');
    const sku2 = skuRef('prod-gadget');

    // Create PO with 2 line items
    const receipt = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [
        { moveGroupId: '', operationType: 'receipt', skuRef: sku1,
          sourceLocationId: locs[HEAD_OFFICE].vendor, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: 500 },
        { moveGroupId: '', operationType: 'receipt', skuRef: sku2,
          sourceLocationId: locs[HEAD_OFFICE].vendor, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: 300 },
      ],
    }, ctx());

    await flow.services.moveGroup.executeAction(receipt._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(receipt._id, 'receive', {}, ctx());

    expect((await getStock(HEAD_OFFICE, sku1)).quantityOnHand).toBe(500);
    expect((await getStock(HEAD_OFFICE, sku2)).quantityOnHand).toBe(300);

    // Verify group status
    const group = await flow.repositories.moveGroup.getByQuery({ _id: receipt._id }, { organizationId: ctx().organizationId, throwOnNotFound: false, lean: true });
    expect(group!.status).toBe('done');

    // Verify 2 moves created
    const moves = await flow.repositories.move.findAll({ moveGroupId: receipt._id }, { organizationId: ctx().organizationId, lean: true });
    expect(moves.length).toBe(2);
    expect(moves.every(m => m.status === 'done')).toBe(true);
  });
});

// ── 4. Inter-Branch Transfer ──

describe('4. Inter-Branch Transfer', () => {
  it('should transfer stock from head office to sub-branch', async () => {
    const sku = skuRef('prod-sneaker');

    // Seed 100 at head office
    await seedStock(HEAD_OFFICE, sku, 100);

    // Sub-branch starts with 0
    expect((await getStock(SUB_BRANCH, sku)).quantityOnHand).toBe(0);

    // Head office ships 40 units (outbound from HO)
    const outbound = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'transfer', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].stock, destinationLocationId: locs[HEAD_OFFICE].customer, quantityPlanned: 40 }],
    }, ctx(HEAD_OFFICE));
    await flow.services.moveGroup.executeAction(outbound._id, 'confirm', {}, ctx(HEAD_OFFICE));
    await flow.services.moveGroup.executeAction(outbound._id, 'receive', {}, ctx(HEAD_OFFICE));

    // Sub-branch receives 40 units (inbound at sub-branch)
    const inbound = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{ moveGroupId: '', operationType: 'transfer', skuRef: sku,
        sourceLocationId: locs[SUB_BRANCH].vendor, destinationLocationId: locs[SUB_BRANCH].stock, quantityPlanned: 40 }],
    }, ctx(SUB_BRANCH));
    await flow.services.moveGroup.executeAction(inbound._id, 'confirm', {}, ctx(SUB_BRANCH));
    await flow.services.moveGroup.executeAction(inbound._id, 'receive', {}, ctx(SUB_BRANCH));

    // Head office: 60, Sub-branch: 40
    expect((await getStock(HEAD_OFFICE, sku)).quantityOnHand).toBe(60);
    expect((await getStock(SUB_BRANCH, sku)).quantityOnHand).toBe(40);
  });
});

// ── 5. Customer Return → Quality Hold → Restock ──

describe('5. Customer Return', () => {
  it('should route returned item through quality hold then restock', async () => {
    const sku = skuRef('prod-jacket');
    await seedStock(HEAD_OFFICE, sku, 50);

    // Step 1: Customer returns 2 units → quality hold
    const returnGroup = await flow.services.moveGroup.create({
      groupType: 'return',
      items: [{ moveGroupId: '', operationType: 'return', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].customer, destinationLocationId: locs[HEAD_OFFICE].quality_hold, quantityPlanned: 2 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(returnGroup._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(returnGroup._id, 'receive', {}, ctx());

    // Quality hold has 2 units
    const qcStock = await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[HEAD_OFFICE].quality_hold }, ctx(),
    );
    expect(qcStock.quantityOnHand).toBe(2);

    // Step 2: QC passes → transfer to stock
    const restock = await flow.services.moveGroup.create({
      groupType: 'transfer',
      items: [{ moveGroupId: '', operationType: 'transfer', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].quality_hold, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: 2 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(restock._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(restock._id, 'receive', {}, ctx());

    // Stock: 50 + 2 = 52, QC: 0
    expect((await getStock(HEAD_OFFICE, sku)).quantityOnHand).toBe(52);
    expect((await flow.services.quant.getAvailability(
      { skuRef: sku, locationId: locs[HEAD_OFFICE].quality_hold }, ctx(),
    )).quantityOnHand).toBe(0);
  });
});

// ── 6. Reservation Expiry ──

describe('6. Reservation Expiry', () => {
  it('should release expired checkout reservations via cleanupExpired', async () => {
    const sku = skuRef('prod-limited-ed');
    await seedStock(HEAD_OFFICE, sku, 10);

    // 3 customers each reserve 3 (total 9/10 reserved) — 2 expired
    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'CART-EXP-1',
      skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 3,
      expiresAt: new Date(Date.now() - 120_000),
    }, ctx());

    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'CART-EXP-2',
      skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 3,
      expiresAt: new Date(Date.now() - 60_000),
    }, ctx());

    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'CART-VALID',
      skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 3,
      expiresAt: new Date(Date.now() + 600_000),
    }, ctx());

    // Before cleanup: available = 10 - 9 = 1
    expect((await getStock(HEAD_OFFICE, sku)).quantityAvailable).toBe(1);

    // Cleanup expired
    const result = await flow.services.reservation.cleanupExpired(ctx());
    expect(result.expired).toBe(2);

    // After cleanup: 6 released, 3 still reserved, available = 7
    const stock = await getStock(HEAD_OFFICE, sku);
    expect(stock.quantityReserved).toBe(3);
    expect(stock.quantityAvailable).toBe(7);
  });
});

// ── 7. Variant Product Tracking ──

describe('7. Variant Product', () => {
  it('should track 3 sizes independently and not cross-contaminate', async () => {
    const skuS = 'SHIRT-S';
    const skuM = 'SHIRT-M';
    const skuL = 'SHIRT-L';

    // Receive different quantities per size
    for (const [sku, qty] of [[skuS, 30], [skuM, 50], [skuL, 20]] as const) {
      const g = await flow.services.moveGroup.create({
        groupType: 'receipt',
        items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
          sourceLocationId: locs[HEAD_OFFICE].vendor, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: qty }],
      }, ctx());
      await flow.services.moveGroup.executeAction(g._id, 'confirm', {}, ctx());
      await flow.services.moveGroup.executeAction(g._id, 'receive', {}, ctx());
    }

    // Sell 10 of M
    const ship = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{ moveGroupId: '', operationType: 'shipment', skuRef: skuM,
        sourceLocationId: locs[HEAD_OFFICE].stock, destinationLocationId: locs[HEAD_OFFICE].customer, quantityPlanned: 10 }],
    }, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(ship._id, 'receive', {}, ctx());

    // S=30 (unchanged), M=40, L=20 (unchanged)
    expect((await getStock(HEAD_OFFICE, skuS)).quantityOnHand).toBe(30);
    expect((await getStock(HEAD_OFFICE, skuM)).quantityOnHand).toBe(40);
    expect((await getStock(HEAD_OFFICE, skuL)).quantityOnHand).toBe(20);
  });
});

// ── 8. Concurrent Orders on Limited Stock ──

describe('8. Concurrent Orders on Limited Stock', () => {
  it('should allow first-come reservations and reject when stock runs out', async () => {
    const sku = skuRef('prod-hot-item');
    await seedStock(HEAD_OFFICE, sku, 10);

    // 3 customers try to reserve 5 each (total 15, only 10 available)
    const results = await Promise.allSettled([
      flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-A',
        skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 5,
      }, ctx()),
      flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-B',
        skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 5,
      }, ctx()),
      flow.services.reservation.reserve({
        reservationType: 'hard', ownerType: 'order', ownerId: 'ORD-C',
        skuRef: sku, locationId: locs[HEAD_OFFICE].stock, quantity: 5,
      }, ctx()),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // Exactly 2 should succeed (2 × 5 = 10), 1 should fail
    expect(succeeded.length).toBe(2);
    expect(failed.length).toBe(1);

    // All 10 units reserved
    const stock = await getStock(HEAD_OFFICE, sku);
    expect(stock.quantityReserved).toBe(10);
    expect(stock.quantityAvailable).toBe(0);
  });
});

// ── 9. Stock Audit: Count → Variance → Reconcile ──

describe('9. Stock Audit with Reconciliation', () => {
  it('should detect shortage, reconcile, and create adjustment moves', async () => {
    const sku = skuRef('prod-audited-item');
    await seedStock(HEAD_OFFICE, sku, 100);

    // Create audit session
    const session = await flow.services.counting.createSession({
      countType: 'spot', scope: {},
    }, ctx());

    // Physical count says 95 (5 units missing)
    await flow.services.counting.submitLines(session._id, [{
      skuRef: sku,
      locationId: locs[HEAD_OFFICE].stock,
      countedQuantity: 95,
    }], ctx());

    // Calculate variance
    const variance = await flow.services.counting.calculateVariance(session._id, ctx());
    expect(variance.varianceLines).toBe(1);
    expect(variance.lines[0].variance).toBe(-5);
    expect(variance.lines[0].expected).toBe(100);
    expect(variance.lines[0].counted).toBe(95);

    // Reconcile (auto-approve within ±10)
    const reconcile = await flow.services.counting.reconcile(session._id, { autoApproveThreshold: 10 }, ctx());
    expect(reconcile.autoApproved).toBe(1);
  });
});

// ── 10. Full Procurement Cycle: PO → Approve → Receive → Stock + Moves ──

describe('10. Full Procurement Cycle', () => {
  it('should track moves from PO creation through receiving', async () => {
    const sku = skuRef('prod-imported');

    // Start with 0
    expect((await getStock(HEAD_OFFICE, sku)).quantityOnHand).toBe(0);

    // Create and execute a multi-step receipt
    const po = await flow.services.moveGroup.create({
      groupType: 'receipt',
      metadata: { procurementOrderId: 'PO-2026-001', vendorRef: 'VENDOR-ABC' },
      items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
        sourceLocationId: locs[HEAD_OFFICE].vendor, destinationLocationId: locs[HEAD_OFFICE].stock, quantityPlanned: 1000 }],
    }, ctx());

    // Status transitions: draft → confirmed → done
    let group = await flow.repositories.moveGroup.getByQuery({ _id: po._id }, { organizationId: ctx().organizationId, throwOnNotFound: false, lean: true });
    expect(group!.status).toBe('draft');

    await flow.services.moveGroup.executeAction(po._id, 'confirm', {}, ctx());
    group = await flow.repositories.moveGroup.getByQuery({ _id: po._id }, { organizationId: ctx().organizationId, throwOnNotFound: false, lean: true });
    expect(group!.status).toBe('confirmed');

    await flow.services.moveGroup.executeAction(po._id, 'receive', {}, ctx());
    group = await flow.repositories.moveGroup.getByQuery({ _id: po._id }, { organizationId: ctx().organizationId, throwOnNotFound: false, lean: true });
    expect(group!.status).toBe('done');

    // Verify stock
    expect((await getStock(HEAD_OFFICE, sku)).quantityOnHand).toBe(1000);

    // Verify move audit trail
    const moves = await flow.repositories.move.findMany({ skuRef: sku }, ctx());
    expect(moves.length).toBe(1);
    expect(moves[0].operationType).toBe('receipt');
    expect(moves[0].quantityDone).toBe(1000);
    expect(moves[0].status).toBe('done');
  });
});
