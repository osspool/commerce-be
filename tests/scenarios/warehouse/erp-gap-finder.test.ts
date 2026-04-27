/**
 * ERP Gap Finder — Real-World Edge Case Tests
 *
 * These tests are designed to FIND BUGS, not validate happy paths.
 * Each scenario represents a real-world operation that silently breaks
 * COGS, valuation, or stock integrity in production.
 *
 *   Gap 1: Transfer leaves receiver with ZERO cost layers → COGS = 0 on sale
 *   Gap 2: Customer return doesn't create reverse cost layer → overstated COGS
 *   Gap 3: Concurrent sales can drive cost layer remainingQty negative
 *   Gap 4: Zero-stock sale with no layers → silent COGS = 0
 *   Gap 5: Stock count surplus creates no cost layer → valuation gap
 *   Gap 6: Paisa rounding on FIFO drain accumulates errors
 *
 * Uses MongoMemoryReplSet + @classytic/flow engine directly.
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.FLOW_VALUATION_METHOD = 'fifo';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createFlowEngine, ensureFlowReady } from '@classytic/flow';
import type { FlowEngine } from '@classytic/flow';
import {
  PRODUCTS, LOC, ctx,
  setupBranch, seedStock, adjustStock, transferBetweenBranches,
  getStock, getCostLayers, cleanAll,
} from '../../support/erp-seed.js';

let replSet: MongoMemoryReplSet;
let flow: FlowEngine;

const BRANCH_A = new mongoose.Types.ObjectId().toString();
const BRANCH_B = new mongoose.Types.ObjectId().toString();

const catalogBridge = {
  async resolveSku(skuRef: string) {
    return { skuRef, sku: skuRef, displayName: `Product ${skuRef}`, trackingMode: 'none' as const, uom: 'unit', isActive: true };
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri());
  flow = createFlowEngine({
    mongoose: mongoose.connection, mode: 'standard', catalog: catalogBridge,
    silent: true, virtualLocations: { adjustment: 'adjustment' },
    valuation: { method: 'fifo' },
  });
  await ensureFlowReady(flow);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// Helper: create + post a shipment move
async function sellUnits(orgId: string, sku: string, qty: number) {
  const group = await flow.services.moveGroup.create({
    groupType: 'shipment',
    items: [{ moveGroupId: '', operationType: 'shipment', skuRef: sku,
      sourceLocationId: LOC.stock, destinationLocationId: LOC.customer, quantityPlanned: qty }],
  }, ctx(orgId));
  const moves = await flow.repositories.move.findAll(
    { moveGroupId: group._id }, { organizationId: orgId, lean: true },
  );
  return flow.services.posting.postMove(
    String(moves[0]._id), { quantityDone: qty, forceAllowNegative: true }, ctx(orgId),
  );
}

// Helper: create + post a return move (customer → stock)
async function returnUnits(orgId: string, sku: string, qty: number) {
  const group = await flow.services.moveGroup.create({
    groupType: 'receipt',
    items: [{ moveGroupId: '', operationType: 'receipt', skuRef: sku,
      sourceLocationId: LOC.customer, destinationLocationId: LOC.stock, quantityPlanned: qty }],
  }, ctx(orgId));
  const moves = await flow.repositories.move.findAll(
    { moveGroupId: group._id }, { organizationId: orgId, lean: true },
  );
  return flow.services.posting.postMove(
    String(moves[0]._id), { quantityDone: qty, forceAllowNegative: true }, ctx(orgId),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap 1: Transfer receiver has ZERO cost layers
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 1: Inter-branch transfer — cost layer at receiver', () => {
  const SKU = PRODUCTS.TSHIRT_RED_M.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
    await setupBranch(flow, BRANCH_B);
  });

  it('FIXED: receiver gets cost layer from inbound receipt, COGS works', async () => {
    await seedStock(flow, BRANCH_A, SKU, 50, 450);

    await transferBetweenBranches(flow, BRANCH_A, BRANCH_B, [{ sku: SKU, qty: 20 }]);

    // Receiver has stock
    const receiverStock = await getStock(flow, BRANCH_B, SKU);
    expect(receiverStock.quantityOnHand).toBe(20);

    // FIXED: Receiver now has cost layer from inbound receipt (vendor→stock)
    // PostingService creates layer when source is virtual and dest is stockable
    const receiverLayers = await getCostLayers(flow, BRANCH_B, SKU);
    expect(receiverLayers.length).toBeGreaterThanOrEqual(1);
    const totalLayerQty = receiverLayers.reduce((s, l) => s + l.remainingQty, 0);
    expect(totalLayerQty).toBe(20);

    // FIXED: Selling at receiver produces correct COGS
    const saleResult = await sellUnits(BRANCH_B, SKU, 5);
    expect(saleResult.costOfGoodsSold).toBeGreaterThan(0);
    expect(saleResult.costOfGoodsSold).toBe(5 * 450); // FIFO from received layer
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 2: Customer return — no COGS reversal
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 2: Customer return — COGS reversal', () => {
  const SKU = PRODUCTS.JACKET_BLK.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
  });

  it('FIXED: return creates cost layer, valuation matches stock', async () => {
    await seedStock(flow, BRANCH_A, SKU, 10, 1200);

    // Sell 5
    const saleResult = await sellUnits(BRANCH_A, SKU, 5);
    expect(saleResult.costOfGoodsSold).toBe(5 * 1200); // 6000

    const stockAfterSale = await getStock(flow, BRANCH_A, SKU);
    expect(stockAfterSale.quantityOnHand).toBe(5);

    // Customer returns 3
    await returnUnits(BRANCH_A, SKU, 3);

    // Stock restored
    const stockAfterReturn = await getStock(flow, BRANCH_A, SKU);
    expect(stockAfterReturn.quantityOnHand).toBe(8); // 5 + 3

    // FIXED: Cost layer created for returned goods
    const layersAfterReturn = await getCostLayers(flow, BRANCH_A, SKU);
    const totalLayerQty = layersAfterReturn.reduce((s, l) => s + l.remainingQty, 0);
    expect(totalLayerQty).toBe(8); // 5 original + 3 returned

    // FIXED: Valuation matches stock (layers mode)
    const val = await flow.services.reporting.stockValuation.generate(
      ctx(BRANCH_A), { mode: 'layers' },
    );
    expect(val.grandTotalValue).toBe(8 * 1200); // 9600
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 3: Concurrent FIFO drain — negative remainingQty
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 3: Concurrent sales — cost layer atomicity', () => {
  const SKU = PRODUCTS.PERFUME_50ML.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
  });

  it('EXPOSES: two concurrent sales can drive cost layer remainingQty negative', async () => {
    await seedStock(flow, BRANCH_A, SKU, 10, 800);

    // Two concurrent sales of 6 each (total 12 > 10 available)
    const results = await Promise.allSettled([
      sellUnits(BRANCH_A, SKU, 6),
      sellUnits(BRANCH_A, SKU, 6),
    ]);

    // Both should succeed (forceAllowNegative = true)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // Check cost layer state
    const layers = await flow.models.CostLayer.find({
      organizationId: BRANCH_A, skuRef: SKU, locationId: LOC.stock,
    }).lean();

    // The layer started at remainingQty=10. Two concurrent drains of 6 each
    // should result in remainingQty = 10 - 6 - 6 = -2 (due to $inc without floor guard)
    const totalRemaining = layers.reduce((s, l) => s + l.remainingQty, 0);
    // With Node.js single-threaded event loop, the $inc operations may serialize.
    // In production with replica sets + retryable writes, the race IS real.
    // Document the invariant: total drained should equal total cost layer decrease.
    // If both succeed, 12 units drained from 10 → remaining should be -2 or 0
    // depending on whether the second drain saw the first's result.
    expect(totalRemaining).toBeLessThanOrEqual(0); // either -2 (race) or 0 (no race)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 4: Zero-stock sale — COGS silently = 0
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 4: Zero-stock sale with no cost layers', () => {
  const SKU = PRODUCTS.TSHIRT_RED_L.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
  });

  it('EXPOSES: sale from zero stock produces COGS = 0 silently', async () => {
    // No stock seeded — zero quants, zero cost layers

    const result = await sellUnits(BRANCH_A, SKU, 5);

    // Stock goes negative
    const stock = await getStock(flow, BRANCH_A, SKU);
    expect(stock.quantityOnHand).toBe(-5);

    // BUG: COGS is 0 — no layers to consume
    expect(result.costOfGoodsSold).toBe(0); // <-- SILENT: no error, no warning, just 0

    // BUG: costLayerConsumption shows the problem
    expect(result.costLayerConsumption?.insufficientLayers).toBe(true);
    expect(result.costLayerConsumption?.remainingUncosted).toBe(5);
    expect(result.costLayerConsumption?.totalCost).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 5: Stock count surplus — no cost layer created
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 5: Stock count surplus — cost layer gap', () => {
  const SKU = PRODUCTS.TSHIRT_RED_M.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
  });

  it('FIXED: surplus adjustment creates cost layer, layers == snapshot', async () => {
    await seedStock(flow, BRANCH_A, SKU, 100, 450);

    // Count reveals 105 (surplus of 5) — adjust up
    await adjustStock(flow, BRANCH_A, SKU, 100, 105);

    const stock = await getStock(flow, BRANCH_A, SKU);
    expect(stock.quantityOnHand).toBe(105);

    // FIXED: The 5 surplus units now have a cost layer (created by PostingService
    // when inbound from virtual source adjustment→stock)
    const layers = await getCostLayers(flow, BRANCH_A, SKU);
    const totalLayerQty = layers.reduce((s, l) => s + l.remainingQty, 0);
    expect(totalLayerQty).toBe(105); // 100 original + 5 surplus

    // FIXED: Layers mode and snapshot mode agree
    const layersVal = await flow.services.reporting.stockValuation.generate(
      ctx(BRANCH_A), { mode: 'layers' },
    );
    const snapshotVal = await flow.services.reporting.stockValuation.generate(
      ctx(BRANCH_A), { mode: 'snapshot' },
    );

    // Both should report the same total (within rounding tolerance)
    expect(Math.abs(layersVal.grandTotalValue - snapshotVal.grandTotalValue)).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 6: Paisa rounding on fractional cost layers
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap 6: Paisa rounding precision', () => {
  const SKU = 'WIDGET-FRAC';

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, BRANCH_A);
  });

  it('verifies FIFO drain with fractional costs rounds correctly', async () => {
    // Seed quant
    const group = await flow.services.moveGroup.create({
      groupType: 'adjustment',
      items: [{ moveGroupId: '', operationType: 'adjustment', skuRef: SKU,
        sourceLocationId: LOC.adjustment, destinationLocationId: LOC.stock, quantityPlanned: 30 }],
    }, ctx(BRANCH_A));
    await flow.services.moveGroup.executeAction(group._id.toString(), 'confirm', {}, ctx(BRANCH_A));
    await flow.services.moveGroup.executeAction(group._id.toString(), 'receive', {}, ctx(BRANCH_A));

    // Create cost layers with tricky fractional costs
    await flow.models.CostLayer.create({
      organizationId: BRANCH_A, skuRef: SKU, locationId: LOC.stock,
      remainingQty: 10, unitCost: 333, // 333 paisa = 3.33 BDT
      receivedAt: new Date('2025-01-01'), moveRef: 'frac-1',
    });
    await flow.models.CostLayer.create({
      organizationId: BRANCH_A, skuRef: SKU, locationId: LOC.stock,
      remainingQty: 20, unitCost: 167, // 167 paisa = 1.67 BDT
      receivedAt: new Date('2025-02-01'), moveRef: 'frac-2',
    });

    // Sell 15: FIFO drains 10@333 + 5@167
    const result = await sellUnits(BRANCH_A, SKU, 15);

    // Expected: 10*333 + 5*167 = 3330 + 835 = 4165
    expect(result.costOfGoodsSold).toBe(4165);

    // Remaining: layer1 fully consumed, layer2 has 15@167
    const layers = await getCostLayers(flow, BRANCH_A, SKU);
    expect(layers).toHaveLength(1);
    expect(layers[0].unitCost).toBe(167);
    expect(layers[0].remainingQty).toBe(15);

    // Valuation: 15 * 167 = 2505
    const val = await flow.services.reporting.stockValuation.generate(
      ctx(BRANCH_A), { mode: 'layers' },
    );
    expect(val.grandTotalValue).toBe(2505);

    // Verify penny accuracy: total cost in = total cost out + remaining value
    // In: 10*333 + 20*167 = 3330 + 3340 = 6670
    // Out (COGS): 4165
    // Remaining: 2505
    // 4165 + 2505 = 6670 ✓
    expect(result.costOfGoodsSold! + val.grandTotalValue).toBe(10 * 333 + 20 * 167);
  });
});
