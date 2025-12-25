/**
 * Inventory Transfer & Movement Integration Tests
 *
 * Coverage:
 * - Head office -> sub-branch transfer workflow
 * - Movement types for challan dispatch/receive
 * - Partial receipt handling
 * - Recount movement type for adjustments
 * - Sub-branch transfer disallowed by default
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import StockMovement from '../../modules/commerce/inventory/stockMovement.model.js';
import transferService from '../../modules/commerce/inventory/transfer/transfer.service.js';
import inventoryService from '../../modules/commerce/inventory/inventory.service.js';
import {
  createTestBranch,
  createTestProduct,
  createTestStockEntry,
} from '../helpers/test-data.js';

const MONGO_URI = process.env.MONGO_URI || globalThis.__MONGO_URI__ || 'mongodb://localhost:27017/bigboss-test';

describe('Inventory Transfers & Movements', () => {
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
    await Branch.deleteMany({});
    await Product.deleteMany({});
    await StockEntry.deleteMany({});
    await StockMovement.deleteMany({});

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

    await StockEntry.create(createTestStockEntry(product._id, headOffice._id, {
      quantity: 20,
      costPrice: 300,
    }));
  });

  it('processes a head-office transfer and records transfer_in/out movements', async () => {
    const transfer = await transferService.createTransfer({
      receiverBranchId: subBranch._id,
      items: [{ productId: product._id, quantity: 5, cartonNumber: 'C-12' }],
    }, actorId);

    expect(transfer.transferType).toBe('head_to_sub');
    expect(transfer.status).toBe('draft');
    expect(transfer.items?.[0]?.cartonNumber).toBe('C-12');

    await transferService.approveTransfer(transfer._id, actorId);
    await transferService.dispatchTransfer(transfer._id, { vehicleNumber: 'DHA-1234' }, actorId);

    const headEntry = await StockEntry.findOne({ product: product._id, branch: headOffice._id });
    expect(headEntry.quantity).toBe(15);

    const transferOut = await StockMovement.findOne({
      'reference.model': 'Challan',
      'reference.id': transfer._id,
      branch: headOffice._id,
      type: 'transfer_out',
    });
    expect(transferOut).toBeTruthy();
    expect(transferOut.quantity).toBe(-5);

    await transferService.receiveTransfer(transfer._id, [], actorId);

    const subEntry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(subEntry.quantity).toBe(5);

    const transferIn = await StockMovement.findOne({
      'reference.model': 'Challan',
      'reference.id': transfer._id,
      branch: subBranch._id,
      type: 'transfer_in',
    });
    expect(transferIn).toBeTruthy();
    expect(transferIn.quantity).toBe(5);
  });

  it('records partial receipt correctly', async () => {
    const transfer = await transferService.createTransfer({
      receiverBranchId: subBranch._id,
      items: [{ productId: product._id, quantity: 10 }],
    }, actorId);

    await transferService.approveTransfer(transfer._id, actorId);
    await transferService.dispatchTransfer(transfer._id, null, actorId);

    const received = await transferService.receiveTransfer(transfer._id, [
      { productId: product._id, quantityReceived: 4 },
    ], actorId);

    expect(received.status).toBe('partial_received');

    const subEntry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(subEntry.quantity).toBe(4);
  });

  it('blocks approve when transfer is already approved', async () => {
    const transfer = await transferService.createTransfer({
      receiverBranchId: subBranch._id,
      items: [{ productId: product._id, quantity: 2 }],
    }, actorId);

    await transferService.approveTransfer(transfer._id, actorId);

    let errorMessage = '';
    try {
      await transferService.approveTransfer(transfer._id, actorId);
    } catch (error) {
      errorMessage = error.message;
    }

    expect(errorMessage).toContain('Only draft transfers can be approved');
  });

  it('creates recount movement when notes include "recount"', async () => {
    await inventoryService.setStock(
      product._id,
      null,
      subBranch._id,
      7,
      'Recount: cycle count adjustment',
      actorId
    );

    const movement = await StockMovement.findOne({
      product: product._id,
      branch: subBranch._id,
      type: 'recount',
    });

    expect(movement).toBeTruthy();
    expect(movement.balanceAfter).toBe(7);
  });

  it('disallows sub-branch returns without permission', async () => {
    let errorMessage = '';
    try {
      await transferService.createTransfer({
        senderBranchId: subBranch._id,
        receiverBranchId: headOffice._id,
        items: [{ productId: product._id, quantity: 1 }],
      }, actorId);
    } catch (error) {
      errorMessage = error.message;
    }

    expect(errorMessage).toContain('Insufficient permission to return stock to head office');
  });

  it('allows sub-branch transfers when permitted', async () => {
    const subBranchTwo = await Branch.create(createTestBranch({
      code: 'SUB2',
      name: 'Sub Branch 2',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    const transfer = await transferService.createTransfer({
      senderBranchId: subBranch._id,
      receiverBranchId: subBranchTwo._id,
      items: [{ productId: product._id, quantity: 2 }],
    }, actorId, { canSubBranchTransfer: true });

    expect(transfer.transferType).toBe('sub_to_sub');
  });

  it('blocks sub-branch transfers when not permitted', async () => {
    const subBranchTwo = await Branch.create(createTestBranch({
      code: 'SUB3',
      name: 'Sub Branch 3',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    let errorMessage = '';
    try {
      await transferService.createTransfer({
        senderBranchId: subBranch._id,
        receiverBranchId: subBranchTwo._id,
        items: [{ productId: product._id, quantity: 2 }],
    }, actorId, { canSubBranchTransfer: false });
    } catch (error) {
      errorMessage = error.message;
    }

    expect(errorMessage).toContain('Insufficient permission to create sub-branch transfers');
  });
});
