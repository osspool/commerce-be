import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import InventoryCounter from '../../modules/commerce/inventory/inventoryCounter.model.js';
import Purchase from '../../modules/commerce/inventory/purchase/purchase.model.js';
import Transfer from '../../modules/commerce/inventory/transfer/transfer.model.js';
import StockRequest from '../../modules/commerce/inventory/stock-request/stock-request.model.js';
import Supplier from '../../modules/commerce/inventory/supplier/supplier.model.js';

describe('Inventory Counter & Numbering', () => {
  let shouldDisconnect = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI);
      shouldDisconnect = true;
    }
  });

  afterAll(async () => {
    if (shouldDisconnect && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await InventoryCounter.deleteMany({});
  });

  it('generates unique sequences under concurrency', async () => {
    const yyyymm = '202501';
    const results = await Promise.all(
      Array.from({ length: 100 }, () => InventoryCounter.nextSeq('PINV', yyyymm))
    );

    const unique = new Set(results);
    expect(unique.size).toBe(100);
    expect(Math.max(...results)).toBe(100);
  });

  it('produces deterministic formats for inventory numbers', async () => {
    const invoice = await Purchase.generateInvoiceNumber();
    expect(invoice).toMatch(/^PINV-\d{6}-\d{4}$/);

    const challan = await Transfer.generateChallanNumber();
    expect(challan).toMatch(/^CHN-\d{6}-\d{4}$/);

    const request = await StockRequest.generateRequestNumber();
    expect(request).toMatch(/^REQ-\d{6}-\d{4}$/);

    const supplierCode = await Supplier.generateCode();
    expect(supplierCode).toMatch(/^SUP-\d{4}$/);
  });
});
