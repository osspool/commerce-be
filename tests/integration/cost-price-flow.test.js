/**
 * Cost Price Flow Integration Tests
 *
 * Ensures cost price has a single source of truth at head office inventory,
 * and that costs propagate through transfers in a predictable, auditable way.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import purchaseService from '../../modules/commerce/inventory/purchase/purchase.service.js';
import transferService from '../../modules/commerce/inventory/transfer/transfer.service.js';

import { createTestProduct } from '../helpers/test-data.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('Cost Price - Head Office Source of Truth', () => {
  let headOffice;
  let subBranch;
  let product;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Branch.deleteMany({});
    await Product.deleteMany({});
    await StockEntry.deleteMany({});

    headOffice = await Branch.create({
      code: 'HO-1',
      name: 'Head Office',
      role: 'head_office',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
    });

    subBranch = await Branch.create({
      code: 'SB-1',
      name: 'Sub Branch',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
      isActive: true,
    });

    product = await Product.create(createTestProduct({ costPrice: 0 }));
  });

  it('records purchase with weighted-average cost and syncs product snapshot', async () => {
    await StockEntry.create({
      product: product._id,
      branch: headOffice._id,
      variantSku: null,
      quantity: 10,
      costPrice: 100,
      isActive: true,
    });

    const actorId = new mongoose.Types.ObjectId();
    await purchaseService.recordPurchase(
      {
        branchId: headOffice._id,
        items: [{ productId: product._id, quantity: 10, costPrice: 200 }],
        supplierName: 'Test Supplier',
      },
      actorId
    );

    const entry = await StockEntry.findOne({ product: product._id, branch: headOffice._id }).lean();
    expect(entry.quantity).toBe(20);
    expect(entry.costPrice).toBeCloseTo(150, 5);

    const refreshed = await Product.findById(product._id).lean();
    expect(refreshed.costPrice).toBeCloseTo(150, 5);
  });

  it('propagates head office cost to receiver stock entries via transfers', async () => {
    await StockEntry.create({
      product: product._id,
      branch: headOffice._id,
      variantSku: null,
      quantity: 50,
      costPrice: 120,
      isActive: true,
    });

    const actorId = new mongoose.Types.ObjectId();

    const transfer = await transferService.createTransfer(
      {
        senderBranchId: headOffice._id,
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 10 }],
        remarks: 'Send stock to branch',
      },
      actorId
    );

    const approved = await transferService.approveTransfer(transfer._id, actorId);
    expect(approved.status).toBe('approved');

    const dispatched = await transferService.dispatchTransfer(transfer._id, {}, actorId);
    expect(dispatched.status).toBe('dispatched');

    const received = await transferService.receiveTransfer(
      transfer._id,
      [{ productId: product._id, variantSku: null, quantityReceived: 10 }],
      actorId
    );
    expect(['received', 'partial_received']).toContain(received.status);

    const receiverEntry = await StockEntry.findOne({
      product: product._id,
      branch: subBranch._id,
      variantSku: null,
    }).lean();

    expect(receiverEntry.quantity).toBe(10);
    expect(receiverEntry.costPrice).toBeCloseTo(120, 5);
  });
});

