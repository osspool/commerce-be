/**
 * ERP Full Business Cycle — Integration Test
 *
 * Tests the complete golden path:
 *
 *   1. Purchase receipt → stock + cost layers
 *   2. Second receipt at higher cost → multi-layer FIFO
 *   3. Inter-branch transfer → stock conservation
 *   4. POS sale → stock decrement + FIFO cost layer drain
 *   5. Stock damage write-off → adjustment move
 *   6. Valuation report → remaining value matches FIFO layers
 *   7. COGS report → sold goods cost matches FIFO consumption
 *   8. Multi-product sale → per-SKU COGS tracking
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
  setupBranch, seedStock, setExactLayers, adjustStock, transferBetweenBranches,
  getStock, getCostLayers, cleanAll,
} from '../../support/erp-seed.js';

let replSet: MongoMemoryReplSet;
let flow: FlowEngine;

const HEAD = new mongoose.Types.ObjectId().toString();
const OUTLET = new mongoose.Types.ObjectId().toString();

const catalogBridge = {
  async resolveSku(skuRef: string) {
    return { skuRef, sku: skuRef, displayName: `Product ${skuRef}`, trackingMode: 'none' as const, uom: 'unit', isActive: true };
  },
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
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
// Scenario: Full ERP Cycle — Purchase → Sale → Transfer → Damage → Reports
// ─────────────────────────────────────────────────────────────────────────────

describe('Full ERP Business Cycle', () => {
  // State shared across steps (sequential execution)
  let tshirtCOGS = 0;
  let jacketCOGS = 0;

  beforeAll(async () => {
    await cleanAll(flow);
    await setupBranch(flow, HEAD);
    await setupBranch(flow, OUTLET);
  });

  // ── Step 1: Purchase receipt at HEAD ──

  it('Step 1: HEAD receives 100 T-Shirts @ 450 from supplier', async () => {
    await seedStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 450);

    const stock = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(stock.quantityOnHand).toBe(100);

    const layers = await getCostLayers(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(layers).toHaveLength(1);
    expect(layers[0].unitCost).toBe(450);
    expect(layers[0].remainingQty).toBe(100);
  });

  it('Step 1b: HEAD receives 50 Jackets @ 1200 from supplier', async () => {
    await seedStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku, 50, 1200);

    const stock = await getStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku);
    expect(stock.quantityOnHand).toBe(50);
  });

  // ── Step 2: Second receipt at higher cost (multi-layer FIFO) ──

  it('Step 2: HEAD receives 50 more T-Shirts @ 500 (price increase)', async () => {
    // Add 50 more quants
    await adjustStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, 100, 150);

    // Set exact 2-layer FIFO state: 100@450 (original) + 50@500 (new receipt)
    await setExactLayers(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku, [
      { qty: 100, unitCost: 450, receivedAt: new Date('2025-01-01') },
      { qty: 50, unitCost: 500, receivedAt: new Date('2025-02-01') },
    ]);

    const stock = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(stock.quantityOnHand).toBe(150);

    const layers = await getCostLayers(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(layers).toHaveLength(2);
    expect(layers[0].unitCost).toBe(450); // older
    expect(layers[1].unitCost).toBe(500); // newer
  });

  // ── Step 3: Transfer to OUTLET ──

  it('Step 3: Transfer 40 T-Shirts + 20 Jackets from HEAD → OUTLET', async () => {
    // transferBetweenBranches now auto-creates cost layers at receiver via PostingService.
    await transferBetweenBranches(flow, HEAD, OUTLET, [
      { sku: PRODUCTS.TSHIRT_RED_M.sku, qty: 40 },
      { sku: PRODUCTS.JACKET_BLK.sku, qty: 20 },
    ]);

    // HEAD decremented
    const headTshirt = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(headTshirt.quantityOnHand).toBe(110); // 150 - 40

    const headJacket = await getStock(flow, HEAD, PRODUCTS.JACKET_BLK.sku);
    expect(headJacket.quantityOnHand).toBe(30); // 50 - 20

    // OUTLET incremented
    const outletTshirt = await getStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(outletTshirt.quantityOnHand).toBe(40);

    const outletJacket = await getStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku);
    expect(outletJacket.quantityOnHand).toBe(20);

    // Conservation: company-wide stock unchanged
    expect(headTshirt.quantityOnHand + outletTshirt.quantityOnHand).toBe(150);
    expect(headJacket.quantityOnHand + outletJacket.quantityOnHand).toBe(50);
  });

  // ── Step 4: POS sale at OUTLET (stock decrement + FIFO drain) ──

  it('Step 4: OUTLET sells 15 T-Shirts + 5 Jackets (POS order)', async () => {
    // Sell 15 T-Shirts
    const tshirtGroup = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment',
        skuRef: PRODUCTS.TSHIRT_RED_M.sku,
        sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
        quantityPlanned: 15,
      }],
    }, ctx(OUTLET));
    const tshirtMoves = await flow.repositories.move.findAll(
      { moveGroupId: tshirtGroup._id }, { organizationId: OUTLET, lean: true },
    );
    const tshirtResult = await flow.services.posting.postMove(
      String(tshirtMoves[0]._id),
      { quantityDone: 15, forceAllowNegative: true },
      ctx(OUTLET),
    );

    // FIFO: 15 units from the 40@450 layer (all from oldest layer)
    expect(tshirtResult.costOfGoodsSold).toBe(15 * 450); // 6750
    tshirtCOGS = tshirtResult.costOfGoodsSold!;

    // Sell 5 Jackets
    const jacketGroup = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment',
        skuRef: PRODUCTS.JACKET_BLK.sku,
        sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
        quantityPlanned: 5,
      }],
    }, ctx(OUTLET));
    const jacketMoves = await flow.repositories.move.findAll(
      { moveGroupId: jacketGroup._id }, { organizationId: OUTLET, lean: true },
    );
    const jacketResult = await flow.services.posting.postMove(
      String(jacketMoves[0]._id),
      { quantityDone: 5, forceAllowNegative: true },
      ctx(OUTLET),
    );

    expect(jacketResult.costOfGoodsSold).toBe(5 * 1200); // 6000
    jacketCOGS = jacketResult.costOfGoodsSold!;

    // Stock after sale
    const outletTshirt = await getStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(outletTshirt.quantityOnHand).toBe(25); // 40 - 15

    const outletJacket = await getStock(flow, OUTLET, PRODUCTS.JACKET_BLK.sku);
    expect(outletJacket.quantityOnHand).toBe(15); // 20 - 5
  });

  // ── Step 5: Damage write-off at OUTLET ──

  it('Step 5: 3 T-Shirts damaged at OUTLET (write-off)', async () => {
    await adjustStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku, 25, 22);

    const stock = await getStock(flow, OUTLET, PRODUCTS.TSHIRT_RED_M.sku);
    expect(stock.quantityOnHand).toBe(22);
  });

  // ── Step 6: Valuation report accuracy ──

  it('Step 6: Valuation report matches remaining FIFO layers', async () => {
    // HEAD valuation
    const headVal = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );
    // HEAD outbound transfer (stock→customer) DRAINED cost layers via FIFO:
    //   T-Shirt: 100@450 → drained 40 → remaining 60@450. Plus 50@500.
    //   Jacket: 50@1200 → drained 20 → remaining 30@1200.
    // HEAD valuation = 60*450 + 50*500 + 30*1200 = 27000 + 25000 + 36000 = 88000
    expect(headVal.grandTotalValue).toBe(60 * 450 + 50 * 500 + 30 * 1200); // 88000

    // OUTLET valuation
    const outletVal = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );
    // OUTLET T-Shirt: started 40@450, sold 15 (drained to 25@450),
    //   damaged 3 (adjustment stock→adjustment drains FIFO → 22@450)
    // OUTLET Jacket: started 20@1200, sold 5 (drained to 15@1200)
    // OUTLET layers: tshirt 22@450 + jacket 15@1200
    // Total: 22*450 + 15*1200 = 9900 + 18000 = 27900
    expect(outletVal.grandTotalValue).toBe(22 * 450 + 15 * 1200); // 27900
    expect(outletVal.totalSkus).toBe(2);
  });

  // ── Step 7: COGS verification ──

  it('Step 7: COGS from sales matches FIFO layer costs', async () => {
    // T-Shirt COGS: 15 sold @ 450 (FIFO from 40@450 layer) = 6750
    expect(tshirtCOGS).toBe(6750);

    // Jacket COGS: 5 sold @ 1200 = 6000
    expect(jacketCOGS).toBe(6000);

    // Total COGS = 6750 + 6000 = 12750
    expect(tshirtCOGS + jacketCOGS).toBe(12_750);
  });

  // ── Step 8: Multi-layer FIFO sale at HEAD ──

  it('Step 8: HEAD sells 120 T-Shirts — FIFO crosses cost layers', async () => {
    // HEAD has: 60@450 (layer 1, after transfer drain) + 50@500 (layer 2) = 110 units in layers
    const group = await flow.services.moveGroup.create({
      groupType: 'shipment',
      items: [{
        moveGroupId: '', operationType: 'shipment',
        skuRef: PRODUCTS.TSHIRT_RED_M.sku,
        sourceLocationId: LOC.stock, destinationLocationId: LOC.customer,
        quantityPlanned: 120,
      }],
    }, ctx(HEAD));
    const moves = await flow.repositories.move.findAll(
      { moveGroupId: group._id }, { organizationId: HEAD, lean: true },
    );
    const result = await flow.services.posting.postMove(
      String(moves[0]._id),
      { quantityDone: 120, forceAllowNegative: true },
      ctx(HEAD),
    );

    // FIFO: 60@450 (all of layer 1, post-transfer) + 50@500 (all of layer 2)
    // = 27000 + 25000 = 52000. Remaining 10 units uncosted (insufficientLayers).
    expect(result.costOfGoodsSold).toBe(60 * 450 + 50 * 500); // 52000
    expect(result.costLayerConsumption!.consumed).toHaveLength(2);
    expect(result.costLayerConsumption!.consumed[0].unitCost).toBe(450);
    expect(result.costLayerConsumption!.consumed[0].quantity).toBe(60);
    expect(result.costLayerConsumption!.consumed[1].unitCost).toBe(500);
    expect(result.costLayerConsumption!.consumed[1].quantity).toBe(50);
    expect(result.costLayerConsumption!.insufficientLayers).toBe(true);

    // HEAD stock after sale
    const headTshirt = await getStock(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(headTshirt.quantityOnHand).toBe(-10); // 110 - 120 (oversold, forceAllowNegative)

    // All tshirt layers fully consumed
    const layers = await getCostLayers(flow, HEAD, PRODUCTS.TSHIRT_RED_M.sku);
    expect(layers).toHaveLength(0);
  });

  // ── Step 9: Final company-wide valuation cross-check ──

  it('Step 9: Company-wide valuation = HEAD + OUTLET remaining value', async () => {
    const headVal = await flow.services.reporting.stockValuation.generate(
      ctx(HEAD), { mode: 'layers' },
    );
    const outletVal = await flow.services.reporting.stockValuation.generate(
      ctx(OUTLET), { mode: 'layers' },
    );

    // After Step 8: HEAD tshirt layers fully consumed, jacket 30@1200 remains.
    // OUTLET: tshirt 22@450 (25 - 3 damage drain), jacket 15@1200.
    // HEAD = 0 + 30*1200 = 36000
    // OUTLET = 22*450 + 15*1200 = 9900 + 18000 = 27900
    // Company total = 36000 + 27900 = 63900

    const companyTotal = headVal.grandTotalValue + outletVal.grandTotalValue;
    expect(companyTotal).toBe(30 * 1200 + 22 * 450 + 15 * 1200); // 63900
  });
});
