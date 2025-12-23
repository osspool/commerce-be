/**
 * Purchase Invoice Flow Integration Tests
 *
 * Ensures supplier purchase invoices can be created, received into stock,
 * and paid with accounting transactions linked to the purchase.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import Supplier from '../../modules/commerce/inventory/supplier/supplier.model.js';
import Transaction from '../../modules/transaction/transaction.model.js';
import purchaseInvoiceService from '../../modules/commerce/inventory/purchase/purchase-invoice.service.js';
import { createTestProduct } from '../helpers/test-data.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bigboss-test';

describe('Purchase Invoice Flow', () => {
  let headOffice;
  let product;
  let supplier;

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
    await Supplier.deleteMany({});
    await Transaction.deleteMany({});

    headOffice = await Branch.create({
      code: 'HO-1',
      name: 'Head Office',
      role: 'head_office',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
    });

    supplier = await Supplier.create({
      name: 'ABC Supplier',
      paymentTerms: 'credit',
      creditDays: 15,
    });

    product = await Product.create(createTestProduct({ costPrice: 0 }));
  });

  it('creates purchase, receives stock, and records payment transaction', async () => {
    const actorId = new mongoose.Types.ObjectId();

    const purchase = await purchaseInvoiceService.createPurchase({
      supplierId: supplier._id,
      items: [
        {
          productId: product._id,
          quantity: 10,
          costPrice: 100,
        },
      ],
    }, actorId);

    expect(purchase.status).toBe('draft');
    expect(purchase.paymentStatus).toBe('unpaid');
    expect(purchase.grandTotal).toBe(1000);

    const received = await purchaseInvoiceService.receivePurchase(purchase._id, actorId);
    expect(received.status).toBe('received');

    const entry = await StockEntry.findOne({
      product: product._id,
      branch: headOffice._id,
      variantSku: null,
    }).lean();

    expect(entry.quantity).toBe(10);
    expect(entry.costPrice).toBe(100);

    const paid = await purchaseInvoiceService.payPurchase(purchase._id, { amount: 1000, method: 'cash' }, actorId);
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.dueAmount).toBe(0);

    const transaction = await Transaction.findOne({
      referenceModel: 'Purchase',
      referenceId: purchase._id,
    }).lean();

    expect(transaction).toBeTruthy();
    expect(transaction?.category).toBe('inventory_purchase');
  });
});
