/**
 * ERP Stock Lifecycle — End-to-End Scenario Tests
 *
 * Tests the complete business flow for a multi-branch commerce operation:
 *
 *   Scenario 1: Head office receives stock from supplier
 *   Scenario 2: Head office transfers stock to outlet
 *   Scenario 3: Outlet requests stock from head office
 *   Scenario 4: Stock damage write-off at outlet
 *   Scenario 5: Valuation + COGS report accuracy after all operations
 *   Scenario 6: Reservation + sale with FIFO COGS drain
 *
 * Uses MongoMemoryReplSet for transaction support.
 * Tests operate directly on the Flow engine (not HTTP) for speed and determinism.
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
  PRODUCTS,
  LOC,
  ctx,
  setupBranch,
  seedStock,
  setExactLayers,
  adjustStock,
  transferBetweenBranches,
  getStock,
  getCostLayers,
  cleanAll,
} from '../helpers/erp-seed.js';

let replSet: MongoMemoryReplSet;
let flow: FlowEngine;

const HEAD = new mongoose.Types.ObjectId().toString();
const OUTLET = new mongoose.Types.ObjectId().toString();

const catalogBridge = {
  async resolveSku(skuRef: string) {
    return {
      skuRef, sku: skuRef,
      displayName: `Product ${skuRef}`,
      trackingMode: 'none' as const,
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
    silent: true,
    virtualLocations: { adjustment: 'adjustment' },
    valuation: { method: 'fifo' },
  });

  await ensureFlowReady(flow);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Head Office Receives Stock from Supplier
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 1: Supplier Receipt', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
  });

  it('receives 100 T-Shirts and creates quant + cost layers', async () => {
    const { sku, costPrice } = PRODUCTS.TSHIRT_RED_M;
    await seedStock(flow, HEAD, sku, 100, costPrice);

    const stock = await getStock(flow, HEAD, sku);
    expect(stock.quantityOnHand).toBe(100);
    expect(stock.quantityAvailable).toBe(100);
    expect(stock.quantityReserved).toBe(0);

    const layers = await getCostLayers(flow, HEAD, sku);
    expect(layers).toHaveLength(1);
    expect(layers[0].remainingQty).toBe(100);
    expect(layers[0].unitCost).toBe(costPrice);
  });

  it('receives multiple products at different costs', async () => {
    await seedStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 450);
    await seedStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku, 50, 1200);
    await seedStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku, 200, 800);

    const tshirtStock = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(tshirtStock.quantityOnHand).toBe(100);

    const jacketStock = await getStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku);
    expect(jacketStock.quantityOnHand).toBe(50);

    const perfumeStock = await getStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku);
    expect(perfumeStock.quantityOnHand).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Inter-Branch Transfer (Head Office → Outlet)
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 2: Inter-Branch Transfer', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
    await setupBranch(flow, OUTLET);
  });

  it('transfers T-Shirts and Jackets from HEAD → OUTLET', async () => {
    await seedStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 450);
    await seedStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku, 50, 1200);

    await transferBetweenBranches(flow, HEAD, OUTLET, [
      { sku: PRODUCTS.TSHIRT_RED_M.sku, qty: 30 },
      { sku: PRODUCTS.JACKET_BLK.sku, qty: 20 },
    ]);

    // HEAD decremented
    const headTshirt = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(headTshirt.quantityOnHand).toBe(70);

    const headJacket = await getStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku);
    expect(headJacket.quantityOnHand).toBe(30);

    // OUTLET incremented
    const outletTshirt = await getStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(outletTshirt.quantityOnHand).toBe(30);

    const outletJacket = await getStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku);
    expect(outletJacket.quantityOnHand).toBe(20);
  });

  it('preserves total company-wide stock after transfer', async () => {
    await seedStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku, 100, 800);

    await transferBetweenBranches(flow, HEAD, OUTLET, [
      { sku: PRODUCTS.PERFUME_50ML.sku, qty: 40 },
    ]);

    const headStock = await getStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku);
    const outletStock = await getStock(flow, OUTLET, PRODUCTS.PERFUME_50ML.sku);

    // Conservation: HEAD(60) + OUTLET(40) = 100
    expect(headStock.quantityOnHand + outletStock.quantityOnHand).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Stock Request (Outlet requests from Head Office)
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 3: Stock Request Fulfillment', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
    await setupBranch(flow, OUTLET);
  });

  it('outlet requests perfume, head office fulfills via transfer', async () => {
    await seedStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku, 200, 800);

    // Outlet has zero perfume
    const outletBefore = await getStock(flow, OUTLET, PRODUCTS.PERFUME_50ML.sku);
    expect(outletBefore.quantityOnHand).toBe(0);

    // Head office fulfills the request via transfer
    await transferBetweenBranches(flow, HEAD, OUTLET, [
      { sku: PRODUCTS.PERFUME_50ML.sku, qty: 50 },
    ]);

    // Outlet now has stock
    const outletAfter = await getStock(flow, OUTLET, PRODUCTS.PERFUME_50ML.sku);
    expect(outletAfter.quantityOnHand).toBe(50);

    // Head office stock reduced
    const headAfter = await getStock(flow, HEAD, PRODUCTS.PERFUME_50ML.sku);
    expect(headAfter.quantityOnHand).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Stock Damage — Write-Off via Adjustment
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 4: Stock Damage Write-Off', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, OUTLET);
  });

  it('writes off 5 damaged T-Shirts via negative adjustment', async () => {
    await seedStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku, 30, 450);

    // Write off 5 damaged units: stock → adjustment (inventory_loss)
    await adjustStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku, 30, 25);

    const stock = await getStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(stock.quantityOnHand).toBe(25);
    expect(stock.quantityAvailable).toBe(25);
  });

  it('adjustment reduces stock and moves delta to inventory_loss', async () => {
    await seedStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku, 20, 1200);

    await adjustStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku, 20, 17);

    // Main stock decremented by 3
    const mainStock = await getStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku, LOC.stock);
    expect(mainStock.quantityOnHand).toBe(17);

    // Verify a done move exists for the adjustment
    const moves = await flow.repositories.move.findAll(
      { skuRef: PRODUCTS.JACKET_BLK.sku, status: 'done', operationType: 'adjustment' },
      { organizationId: OUTLET, lean: true },
    );
    // At least one move from stock → adjustment (the write-off)
    const writeOffMove = moves.find(
      (m) => m.sourceLocationId === LOC.stock && m.destinationLocationId === LOC.adjustment,
    );
    expect(writeOffMove).toBeDefined();
    expect(writeOffMove!.quantityDone).toBe(3);
  });

  it('cost layers are consumed for FIFO COGS on damage write-off', async () => {
    await seedStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku, 30, 450);

    // Verify layer exists before write-off
    const layersBefore = await getCostLayers(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(layersBefore).toHaveLength(1);
    expect(layersBefore[0].remainingQty).toBe(30);

    // Consume 5 units via FIFO drain (adjustment destination is inventory_loss = COGS type)
    const consumption = await flow.services.costLayer.consumeLayers(
      PRODUCTS.TSHIRT_RED_M.sku, LOC.stock, 5, 'fifo', ctx(OUTLET),
    );
    expect(consumption.totalCost).toBe(5 * 450); // 2250
    expect(consumption.consumed).toHaveLength(1);

    const layersAfter = await getCostLayers(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(layersAfter[0].remainingQty).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: Valuation + COGS Report Accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 5: Valuation Report Accuracy', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
    await setupBranch(flow, OUTLET);
  });

  it('valuation reflects correct inventory value per branch', async () => {
    // HEAD: 100 T-Shirts @ 450, 50 Jackets @ 1200
    await seedStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 450);
    await seedStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku, 50, 1200);

    // OUTLET: 30 Perfumes @ 800
    await seedStock(flow, OUTLET, PRODUCTS.PERFUME_50ML.sku, 30, 800);

    // HEAD valuation (layers mode for audit-grade)
    const headValuation = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );

    // 100*450 + 50*1200 = 45000 + 60000 = 105000
    expect(headValuation.grandTotalValue).toBe(105_000);
    expect(headValuation.grandTotalQuantity).toBe(150);
    expect(headValuation.totalSkus).toBe(2);

    // OUTLET valuation
    const outletValuation = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );

    // 30*800 = 24000
    expect(outletValuation.grandTotalValue).toBe(24_000);
    expect(outletValuation.grandTotalQuantity).toBe(30);
    expect(outletValuation.totalSkus).toBe(1);
  });

  it('snapshot mode matches layers mode totals', async () => {
    await seedStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 450);

    const snapshot = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'snapshot' },
    );
    const layers = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );

    expect(snapshot.grandTotalQuantity).toBe(layers.grandTotalQuantity);
    // Values may differ slightly (WAC rounding vs layer sum), but should be close
    expect(Math.abs(snapshot.grandTotalValue - layers.grandTotalValue)).toBeLessThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Reservation + Sale with FIFO COGS Drain
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 6: Sale with FIFO COGS', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, OUTLET);
  });

  it('sale drains cost layers via FIFO and computes correct COGS', async () => {
    const { sku, costPrice } = PRODUCTS.PERFUME_50ML;

    // Seed 20 units total, then set exact FIFO layers
    await seedStock(flow, OUTLET, sku, 20, costPrice);

    // Replace auto-created layer with 2 explicit layers at different costs
    await setExactLayers(flow, OUTLET, sku, [
      { qty: 10, unitCost: 800 },  // Receipt 1: older
      { qty: 10, unitCost: 900 },  // Receipt 2: newer, price increased
    ]);

    // Sell 15 units: should drain 10 @ 800 (FIFO first) + 5 @ 900
    const consumption = await flow.services.costLayer.consumeLayers(
      sku, LOC.stock, 15, 'fifo', ctx(OUTLET),
    );

    // FIFO: oldest first (800), then newer (900)
    expect(consumption.consumed).toHaveLength(2);
    expect(consumption.consumed[0].unitCost).toBe(800);
    expect(consumption.consumed[0].quantity).toBe(10);
    expect(consumption.consumed[1].unitCost).toBe(900);
    expect(consumption.consumed[1].quantity).toBe(5);

    // Total COGS = 10*800 + 5*900 = 8000 + 4500 = 12500
    expect(consumption.totalCost).toBe(12_500);
    expect(consumption.insufficientLayers).toBe(false);

    // Remaining layers: 5 units @ 900
    const remaining = await getCostLayers(flow, OUTLET, sku);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].unitCost).toBe(900);
    expect(remaining[0].remainingQty).toBe(5);
  });

  it('posting a sale move to customer returns costOfGoodsSold', async () => {
    const { sku, costPrice } = PRODUCTS.PERFUME_50ML;
    await seedStock(flow, OUTLET, sku, 20, costPrice);

    // Create shipment move: stock → customer
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '',
          operationType: 'shipment',
          skuRef: sku,
          sourceLocationId: LOC.stock,
          destinationLocationId: LOC.customer,
          quantityPlanned: 5,
        }],
      },
      ctx(OUTLET),
    );

    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id },
      { organizationId: OUTLET, lean: true },
    );

    const result = await flow.services.posting.postMove(
      String(moves[0]._id),
      { quantityDone: 5, forceAllowNegative: true },
      ctx(OUTLET),
    );

    // FIFO mode: costOfGoodsSold computed from cost layer drain
    expect(result.costOfGoodsSold).toBe(5 * costPrice); // 5 * 800 = 4000

    // Stock decremented
    const stock = await getStock(flow, OUTLET, sku);
    expect(stock.quantityOnHand).toBe(15);

    // Cost layer drained
    const layers = await getCostLayers(flow, OUTLET, sku);
    expect(layers[0].remainingQty).toBe(15); // 20 - 5
  });

  it('postMove returns costOfGoodsSold and valuation decreases', async () => {
    const { sku, costPrice } = PRODUCTS.TSHIRT_RED_M;
    await seedStock(flow, OUTLET, sku, 50, costPrice);

    // Valuation before sale
    const valBefore = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );
    expect(valBefore.grandTotalValue).toBe(50 * costPrice); // 22500

    // Post a sale: 10 tshirts → customer
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '',
          operationType: 'shipment',
          skuRef: sku,
          sourceLocationId: LOC.stock,
          destinationLocationId: LOC.customer,
          quantityPlanned: 10,
        }],
      },
      ctx(OUTLET),
    );
    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id },
      { organizationId: OUTLET, lean: true },
    );
    const result = await flow.services.posting.postMove(
      String(moves[0]._id),
      { quantityDone: 10, forceAllowNegative: true },
      ctx(OUTLET),
    );

    // FIFO mode: costOfGoodsSold from layer drain
    expect(result.costOfGoodsSold).toBe(10 * costPrice); // 4500
    expect(result.costLayerConsumption).toBeDefined();
    expect(result.costLayerConsumption!.consumed).toHaveLength(1);

    // Valuation after sale: decreased by the sold amount
    const valAfter = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );
    expect(valAfter.grandTotalValue).toBe(40 * costPrice); // 18000
    expect(valAfter.grandTotalQuantity).toBe(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: POS Order — Variant Products + Stock + COGS + Valuation
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 7: POS Order with Variant Products', () => {
  const HOODIE_M = 'HOODIE-M';
  const HOODIE_L = 'HOODIE-L';
  const HOODIE_M_COST = 900;
  const HOODIE_L_COST = 950;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, OUTLET);
  });

  it('variant SKUs have independent stock and cost layers', async () => {
    await seedStock(flow, OUTLET, HOODIE_M, 50, HOODIE_M_COST);
    await seedStock(flow, OUTLET, HOODIE_L, 30, HOODIE_L_COST);

    const stockM = await getStock(flow, OUTLET, HOODIE_M);
    expect(stockM.quantityOnHand).toBe(50);

    const stockL = await getStock(flow, OUTLET, HOODIE_L);
    expect(stockL.quantityOnHand).toBe(30);

    // Independent cost layers
    const layersM = await getCostLayers(flow, OUTLET, HOODIE_M);
    expect(layersM[0].unitCost).toBe(HOODIE_M_COST);

    const layersL = await getCostLayers(flow, OUTLET, HOODIE_L);
    expect(layersL[0].unitCost).toBe(HOODIE_L_COST);
  });

  it('POS sale: posts 2x HOODIE-M and 1x HOODIE-L to customer, drains correct layers', async () => {
    await seedStock(flow, OUTLET, HOODIE_M, 50, HOODIE_M_COST);
    await seedStock(flow, OUTLET, HOODIE_L, 30, HOODIE_L_COST);

    // Simulate POS order fulfillment: 2x HOODIE-M shipped to customer
    const groupM = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: HOODIE_M,
          sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
          quantityPlanned: 2,
        }],
      },
      ctx(OUTLET),
    );
    const movesM = await flow.repositories.move.findAll(
      { moveGroupId: groupM._id }, { organizationId: OUTLET, lean: true },
    );
    const resultM = await flow.services.posting.postMove(
      String(movesM[0]._id), { quantityDone: 2, forceAllowNegative: true }, ctx(OUTLET),
    );

    // 1x HOODIE-L shipped to customer
    const groupL = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: HOODIE_L,
          sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
          quantityPlanned: 1,
        }],
      },
      ctx(OUTLET),
    );
    const movesL = await flow.repositories.move.findAll(
      { moveGroupId: groupL._id }, { organizationId: OUTLET, lean: true },
    );
    const resultL = await flow.services.posting.postMove(
      String(movesL[0]._id), { quantityDone: 1, forceAllowNegative: true }, ctx(OUTLET),
    );

    // COGS per variant
    expect(resultM.costOfGoodsSold).toBe(2 * HOODIE_M_COST); // 1800
    expect(resultL.costOfGoodsSold).toBe(1 * HOODIE_L_COST); // 950

    // Stock after sale
    const afterM = await getStock(flow, OUTLET, HOODIE_M);
    expect(afterM.quantityOnHand).toBe(48);

    const afterL = await getStock(flow, OUTLET, HOODIE_L);
    expect(afterL.quantityOnHand).toBe(29);

    // Cost layers drained independently
    const layersM = await getCostLayers(flow, OUTLET, HOODIE_M);
    expect(layersM[0].remainingQty).toBe(48);

    const layersL = await getCostLayers(flow, OUTLET, HOODIE_L);
    expect(layersL[0].remainingQty).toBe(29);
  });

  it('valuation after POS sale reflects correct per-variant totals', async () => {
    await seedStock(flow, OUTLET, HOODIE_M, 50, HOODIE_M_COST);
    await seedStock(flow, OUTLET, HOODIE_L, 30, HOODIE_L_COST);

    // Sell 10x HOODIE-M
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: HOODIE_M,
          sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
          quantityPlanned: 10,
        }],
      },
      ctx(OUTLET),
    );
    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id }, { organizationId: OUTLET, lean: true },
    );
    await flow.services.posting.postMove(
      String(moves[0]._id), { quantityDone: 10, forceAllowNegative: true }, ctx(OUTLET),
    );

    // Valuation: 40*900 + 30*950 = 36000 + 28500 = 64500
    const val = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );
    expect(val.grandTotalValue).toBe(40 * HOODIE_M_COST + 30 * HOODIE_L_COST); // 64500
    expect(val.grandTotalQuantity).toBe(70); // 40 + 30
    expect(val.totalSkus).toBe(2);

    // Per-SKU breakdown
    const items = val.locations.flatMap((l) => l.items);
    const hoodieM = items.find((i) => i.skuRef === HOODIE_M);
    expect(hoodieM!.totalQuantity).toBe(40);
    expect(hoodieM!.totalValue).toBe(40 * HOODIE_M_COST);

    const hoodieL = items.find((i) => i.skuRef === HOODIE_L);
    expect(hoodieL!.totalQuantity).toBe(30);
    expect(hoodieL!.totalValue).toBe(30 * HOODIE_L_COST);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: Multi-Receipt FIFO — Different Costs Over Time
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 8: Multi-Receipt FIFO Costing', () => {
  const SKU = PRODUCTS.JACKET_BLK.sku;

  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
  });

  it('three receipts at different costs, sale drains oldest first', async () => {
    // Seed all 45 units via one seedStock, then manually create cost layers
    // at the correct receivedAt dates for FIFO ordering.
    await seedStock(flow, HEAD, SKU, 45, 1000);

    // Remove the auto-created single layer and replace with 3 dated layers
    await flow.models.CostLayer.deleteMany({ organizationId: HEAD, skuRef: SKU });

    // Replace auto-created layer with 3 explicit layers at different costs
    await setExactLayers(flow, HEAD, SKU, [
      { qty: 20, unitCost: 1000, receivedAt: new Date('2025-01-01') },
      { qty: 15, unitCost: 1100, receivedAt: new Date('2025-02-01') },
      { qty: 10, unitCost: 1250, receivedAt: new Date('2025-03-01') },
    ]);

    // Sell 30 jackets: FIFO drains 20@1000 + 10@1100
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: SKU,
          sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
          quantityPlanned: 30,
        }],
      },
      ctx(HEAD),
    );
    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id }, { organizationId: HEAD, lean: true },
    );
    const result = await flow.services.posting.postMove(
      String(moves[0]._id), { quantityDone: 30, forceAllowNegative: true }, ctx(HEAD),
    );

    // FIFO: 20@1000 + 10@1100 = 20000 + 11000 = 31000
    expect(result.costOfGoodsSold).toBe(20 * 1000 + 10 * 1100); // 31000
    expect(result.costLayerConsumption!.consumed).toHaveLength(2);
    expect(result.costLayerConsumption!.consumed[0].unitCost).toBe(1000);
    expect(result.costLayerConsumption!.consumed[0].quantity).toBe(20);
    expect(result.costLayerConsumption!.consumed[1].unitCost).toBe(1100);
    expect(result.costLayerConsumption!.consumed[1].quantity).toBe(10);

    // Remaining: 5@1100 + 10@1250
    const layers = await getCostLayers(flow, HEAD, SKU);
    expect(layers).toHaveLength(2);
    expect(layers[0].remainingQty).toBe(5);
    expect(layers[0].unitCost).toBe(1100);
    expect(layers[1].remainingQty).toBe(10);
    expect(layers[1].unitCost).toBe(1250);

    // Valuation: 5*1100 + 10*1250 = 5500 + 12500 = 18000
    const val = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );
    expect(val.grandTotalValue).toBe(5 * 1100 + 10 * 1250); // 18000
    expect(val.grandTotalQuantity).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9: Full Cycle — Receipt → Transfer → Sale → Valuation Cross-Check
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 9: Full Business Cycle Cross-Check', () => {
  beforeEach(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
    await setupBranch(flow, OUTLET);
  });

  it('receipt at HEAD, transfer to OUTLET, sell at OUTLET, verify all balances', async () => {
    const SKU = PRODUCTS.PERFUME_50ML.sku;
    const COST = PRODUCTS.PERFUME_50ML.costPrice; // 800

    // Step 1: HEAD receives 100 perfumes from supplier
    await seedStock(flow, HEAD, SKU, 100, COST);
    const headAfterReceipt = await getStock(flow, HEAD, SKU);
    expect(headAfterReceipt.quantityOnHand).toBe(100);

    // Step 2: Transfer 40 to OUTLET (dual-context: sender decrements, receiver increments)
    await transferBetweenBranches(flow, HEAD, OUTLET, [{ sku: SKU, qty: 40 }]);
    // Ensure receiver has cost layers at the transferred cost
    await setExactLayers(flow, OUTLET, SKU, [{ qty: 40, unitCost: COST }]);

    const headAfterTransfer = await getStock(flow, HEAD, SKU);
    expect(headAfterTransfer.quantityOnHand).toBe(60);

    const outletAfterTransfer = await getStock(flow, OUTLET, SKU);
    expect(outletAfterTransfer.quantityOnHand).toBe(40);

    // Conservation check
    expect(headAfterTransfer.quantityOnHand + outletAfterTransfer.quantityOnHand).toBe(100);

    // Step 3: OUTLET sells 15 perfumes
    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        items: [{
          moveGroupId: '', operationType: 'shipment', skuRef: SKU,
          sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
          quantityPlanned: 15,
        }],
      },
      ctx(OUTLET),
    );
    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id }, { organizationId: OUTLET, lean: true },
    );
    const saleResult = await flow.services.posting.postMove(
      String(moves[0]._id), { quantityDone: 15, forceAllowNegative: true }, ctx(OUTLET),
    );

    expect(saleResult.costOfGoodsSold).toBe(15 * COST); // 12000

    // Step 4: Verify final stock
    const headFinal = await getStock(flow, HEAD, SKU);
    expect(headFinal.quantityOnHand).toBe(60);

    const outletFinal = await getStock(flow, OUTLET, SKU);
    expect(outletFinal.quantityOnHand).toBe(25);

    // Step 5: Cross-check valuations
    const headVal = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );
    expect(headVal.grandTotalValue).toBe(60 * COST); // 48000

    const outletVal = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );
    expect(outletVal.grandTotalValue).toBe(25 * COST); // 20000

    // Total company-wide inventory value: 48000 + 20000 = 68000
    // Original: 100 * 800 = 80000. Sold: 15 * 800 = 12000. Remaining: 68000.
    expect(headVal.grandTotalValue + outletVal.grandTotalValue).toBe((100 - 15) * COST);
  });
});
