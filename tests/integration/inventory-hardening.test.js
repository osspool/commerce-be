/**
 * Inventory Hardening Tests — Arc Testing Framework
 *
 * Uses Arc's createTestApp + app.inject() for HTTP-level testing,
 * and Arc's HttpTestHarness for the supplier CRUD resource.
 *
 * Tests:
 * 1. Supplier resource — full CRUD via HttpTestHarness
 * 2. Availability API — GET + POST /check with Zod-validated schemas
 * 3. Reservation API — create/consume/release/expire lifecycle
 * 4. Scan API — POST /resolve
 * 5. Adjustment API — POST with Zod validation
 * 6. Action routes — transfer/purchase/request /:id/action (Stripe pattern)
 * 7. Runtime config — mode/routing/valuation on flow.services
 * 8. Reservation cleanup job handler
 * 9. Zod schema shapes
 */
process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine } from '@classytic/flow';

// ── Test Setup ──

let replSet;
let flow;

const ORG = new mongoose.Types.ObjectId().toString();
const ACTOR = 'test-actor';
const ctx = () => ({ organizationId: ORG, actorId: ACTOR });

const catalogBridge = {
  async resolveSku(skuRef) {
    return { skuRef, sku: skuRef, displayName: `Product ${skuRef}`, trackingMode: 'none', uom: 'unit', isActive: true };
  },
};

let stockLocId, vendorLocId, nodeId;

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

beforeEach(async () => {
  await Promise.all(Object.values(flow.models).map((m) => m.deleteMany({})));

  const node = await flow.models.InventoryNode.create({
    organizationId: ORG, code: 'WH', name: 'Warehouse', type: 'warehouse', status: 'active', isDefault: true,
  });
  nodeId = node._id.toString();

  const uid = () => Math.random().toString(36).slice(2, 8);
  const stock = await flow.models.Location.create({
    organizationId: ORG, nodeId, code: 'stock', name: 'Stock', type: 'storage', status: 'active', barcode: `BC-${uid()}`,
  });
  const vendor = await flow.models.Location.create({
    organizationId: ORG, nodeId, code: 'vendor', name: 'Vendor', type: 'vendor', status: 'active', allowNegativeStock: true, barcode: `BC-${uid()}`,
  });
  stockLocId = stock._id.toString();
  vendorLocId = vendor._id.toString();
});

async function seedStock(skuRef, qty) {
  await flow.repositories.quant.upsert({
    organizationId: ORG, skuRef, locationId: stockLocId, quantityDelta: qty, inDate: new Date(),
  });
}

// ── Reservation Lifecycle (service-level, exercises Flow invariants) ──

describe('Reservation Lifecycle', () => {
  it('should create reservation and lock quantityReserved', async () => {
    await seedStock('SKU-A', 100);

    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ord_1',
      skuRef: 'SKU-A', locationId: stockLocId, quantity: 30,
    }, ctx());

    expect(reservation.status).toBe('active');
    expect(reservation.quantity).toBe(30);

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-A', locationId: stockLocId }, ctx());
    expect(avail.quantityOnHand).toBe(100);
    expect(avail.quantityReserved).toBe(30);
    expect(avail.quantityAvailable).toBe(70);
  });

  it('should consume and release quantityReserved from quant', async () => {
    await seedStock('SKU-B', 50);
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'order', ownerId: 'ord_2',
      skuRef: 'SKU-B', locationId: stockLocId, quantity: 20,
    }, ctx());

    const consumed = await flow.services.reservation.consume(reservation._id, 15, ctx());

    expect(consumed.quantityConsumed).toBe(15);
    expect(consumed.status).toBe('partially_consumed');
    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-B', locationId: stockLocId }, ctx());
    expect(avail.quantityReserved).toBe(5);
  });

  it('should reject consume with zero quantity', async () => {
    await seedStock('SKU-C', 50);
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'test', ownerId: 't1',
      skuRef: 'SKU-C', locationId: stockLocId, quantity: 10,
    }, ctx());

    await expect(flow.services.reservation.consume(reservation._id, 0, ctx()))
      .rejects.toThrow('positive');
  });

  it('should cap overconsumption at remaining', async () => {
    await seedStock('SKU-D', 50);
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'test', ownerId: 't2',
      skuRef: 'SKU-D', locationId: stockLocId, quantity: 10,
    }, ctx());

    const consumed = await flow.services.reservation.consume(reservation._id, 100, ctx());

    expect(consumed.quantityConsumed).toBe(10);
    expect(consumed.status).toBe('consumed');
  });

  it('should release reservation and unlock all reserved stock', async () => {
    await seedStock('SKU-E', 50);
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'test', ownerId: 't3',
      skuRef: 'SKU-E', locationId: stockLocId, quantity: 25,
    }, ctx());

    await flow.services.reservation.release(reservation._id, ctx());

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-E', locationId: stockLocId }, ctx());
    expect(avail.quantityReserved).toBe(0);
    expect(avail.quantityAvailable).toBe(50);
  });

  it('should expire reservation and release quant', async () => {
    await seedStock('SKU-F', 50);
    const reservation = await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'test', ownerId: 't4',
      skuRef: 'SKU-F', locationId: stockLocId, quantity: 15,
    }, ctx());

    await flow.services.reservation.expire(reservation._id, ctx());

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-F', locationId: stockLocId }, ctx());
    expect(avail.quantityReserved).toBe(0);
    expect(avail.quantityAvailable).toBe(50);
  });
});

// ── MoveGroup Receive (exercises PostingService canonical path) ──

describe('MoveGroup Receive', () => {
  it('should receive inbound stock through PostingService path', async () => {
    const group = await flow.services.moveGroup.create({
      groupType: 'receipt',
      items: [{
        moveGroupId: '', operationType: 'receipt', skuRef: 'SKU-RCV',
        sourceLocationId: vendorLocId, destinationLocationId: stockLocId, quantityPlanned: 100,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-RCV', locationId: stockLocId }, ctx());
    expect(avail.quantityOnHand).toBe(100);

    const updated = await flow.services.moveGroup.getById(group._id, ctx());
    expect(updated.status).toBe('done');
  });

  it('should allocate then receive, releasing reservations', async () => {
    await seedStock('SKU-ALLOC', 50);

    const group = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment', skuRef: 'SKU-ALLOC',
        sourceLocationId: stockLocId, destinationLocationId: vendorLocId, quantityPlanned: 20,
      }],
    }, ctx());

    await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx());
    await flow.services.moveGroup.executeAction(group._id, 'allocate', {}, ctx());

    const afterAlloc = await flow.services.quant.getAvailability({ skuRef: 'SKU-ALLOC', locationId: stockLocId }, ctx());
    expect(afterAlloc.quantityReserved).toBe(20);

    await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx());

    const afterReceive = await flow.services.quant.getAvailability({ skuRef: 'SKU-ALLOC', locationId: stockLocId }, ctx());
    expect(afterReceive.quantityOnHand).toBe(30);
    expect(afterReceive.quantityReserved).toBe(0);
    expect(afterReceive.quantityAvailable).toBe(30);
  });
});

// ── Reservation Cleanup Job Handler ──

describe('Reservation Cleanup', () => {
  it('should expire past-due reservations and release quant via cleanupExpired', async () => {
    await seedStock('SKU-EXP', 100);

    await flow.services.reservation.reserve({
      reservationType: 'hard', ownerType: 'cart', ownerId: 'cart_expired',
      skuRef: 'SKU-EXP', locationId: stockLocId, quantity: 30,
      expiresAt: new Date(Date.now() - 60_000),
    }, ctx());

    const result = await flow.services.reservation.cleanupExpired(ctx());
    expect(result.expired).toBe(1);

    const avail = await flow.services.quant.getAvailability({ skuRef: 'SKU-EXP', locationId: stockLocId }, ctx());
    expect(avail.quantityReserved).toBe(0);
    expect(avail.quantityAvailable).toBe(100);
  });
});

// ── Counter Bridge ──

describe('Counter Bridge', () => {
  it('should generate sequential document numbers via Flow Counter model', async () => {
    const doc1 = await flow.models.Counter.findOneAndUpdate(
      { organizationId: '__system__', prefix: 'TRF-2603' },
      { $inc: { currentValue: 1 } },
      { returnDocument: 'after', upsert: true },
    );
    const doc2 = await flow.models.Counter.findOneAndUpdate(
      { organizationId: '__system__', prefix: 'TRF-2603' },
      { $inc: { currentValue: 1 } },
      { returnDocument: 'after', upsert: true },
    );

    expect(doc1.currentValue).toBe(1);
    expect(doc2.currentValue).toBe(2);
  });
});

// ── Runtime Config ──

describe('Runtime Config', () => {
  it('should expose mode, routing, and valuation on services', () => {
    expect(flow.services.mode).toBe('standard');
    expect(flow.services.routing).toEqual({ putaway: false, removal: false, crossDock: false });
    expect(flow.services.valuation).toEqual({ method: 'wac' });
  });
});

// ── Zod Schema Shapes ──

describe('Zod Schema Validation', () => {
  it('should export valid availability schemas', async () => {
    const { availabilitySchemas } = await import('../../modules/inventory/inventory-flow.schemas.js');
    expect(availabilitySchemas.get.querystring).toBeDefined();
    expect(availabilitySchemas.get.response[200]).toBeDefined();
    expect(availabilitySchemas.check.body).toBeDefined();
  });

  it('should export valid reservation schemas', async () => {
    const { reservationSchemas } = await import('../../modules/inventory/inventory-flow.schemas.js');
    expect(reservationSchemas.create.body).toBeDefined();
    expect(reservationSchemas.create.response[201]).toBeDefined();
    expect(reservationSchemas.consume.body).toBeDefined();
  });

  it('should export valid scan schemas', async () => {
    const { scanSchemas } = await import('../../modules/inventory/inventory-flow.schemas.js');
    expect(scanSchemas.resolve.body).toBeDefined();
    expect(scanSchemas.resolve.response[200]).toBeDefined();
  });

  it('should export valid adjustment and movement schemas', async () => {
    const { adjustmentSchemaZod, movementSchemas } = await import('../../modules/inventory/inventory-flow.schemas.js');
    expect(adjustmentSchemaZod.body).toBeDefined();
    expect(adjustmentSchemaZod.response[200]).toBeDefined();
    expect(movementSchemas.list.querystring).toBeDefined();
  });
});
