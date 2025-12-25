/**
 * Stock Request Fulfillment Integration Tests
 *
 * Ensures partial fulfill quantities are respected and tracked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import StockRequest, { StockRequestStatus } from '../../modules/commerce/inventory/stock-request/stock-request.model.js';
import Transfer from '../../modules/commerce/inventory/transfer/transfer.model.js';
import InventoryCounter from '../../modules/commerce/inventory/inventoryCounter.model.js';
import stockRequestService from '../../modules/commerce/inventory/stock-request/stock-request.service.js';
import { createTestBranch, createTestProduct } from '../helpers/test-data.js';

const MONGO_URI = process.env.MONGO_URI || globalThis.__MONGO_URI__ || 'mongodb://localhost:27017/bigboss-test';

describe('Stock Request Fulfillment', () => {
  let headOffice;
  let subBranch;
  let product;
  let actorId;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGO_URI);
    }
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Promise.all([
      Branch.deleteMany({}),
      Product.deleteMany({}),
      StockEntry.deleteMany({}),
      StockRequest.deleteMany({}),
      Transfer.deleteMany({}),
      InventoryCounter.deleteMany({}),
    ]);

    actorId = new mongoose.Types.ObjectId();

    headOffice = await Branch.create(createTestBranch({
      code: 'HO',
      name: 'Head Office',
      role: 'head_office',
      type: 'warehouse',
      isDefault: true,
    }));

    subBranch = await Branch.create(createTestBranch({
      code: 'SUB1',
      name: 'Sub Branch 1',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    product = await Product.create(createTestProduct());
  });

  it('allows partial fulfill and tracks fulfilled quantities', async () => {
    const request = await stockRequestService.createRequest({
      requestingBranchId: subBranch._id,
      items: [{ productId: product._id, quantity: 10 }],
      priority: 'high',
    }, actorId);

    await stockRequestService.approveRequest(request._id, null, 'Approved', actorId);

    const result = await stockRequestService.fulfillRequest(request._id, {
      items: [{ productId: product._id, quantity: 4 }],
      documentType: 'delivery_challan',
    }, actorId);

    expect(result.transfer.items[0].quantity).toBe(4);

    const updated = await StockRequest.findById(request._id).lean();
    expect(updated.status).toBe(StockRequestStatus.PARTIAL_FULFILLED);
    expect(updated.totalQuantityApproved).toBe(10);
    expect(updated.totalQuantityFulfilled).toBe(4);
    expect(updated.items[0].quantityFulfilled).toBe(4);
    expect(updated.transfer?.toString()).toBe(result.transfer._id.toString());
  });

  it('blocks fulfill quantities above approved', async () => {
    const request = await stockRequestService.createRequest({
      requestingBranchId: subBranch._id,
      items: [{ productId: product._id, quantity: 6 }],
      priority: 'high',
    }, actorId);

    await stockRequestService.approveRequest(request._id, [
      { productId: product._id, quantityApproved: 4 },
    ], 'Approved limited qty', actorId);

    let errorMessage = '';
    try {
      await stockRequestService.fulfillRequest(request._id, {
        items: [{ productId: product._id, quantity: 5 }],
      }, actorId);
    } catch (error) {
      errorMessage = error.message;
    }

    expect(errorMessage).toContain('Fulfill quantity exceeds approved quantity');
  });
});
