// Set env vars BEFORE imports
process.env.JWT_SECRET = 'test-secret-key-123456789';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.REDX_API_KEY = process.env.REDX_API_KEY || 'test-redx-key';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import StockEntry from '../../modules/commerce/inventory/stockEntry.model.js';
import StockMovement from '../../modules/commerce/inventory/stockMovement.model.js';
import Transfer from '../../modules/commerce/inventory/transfer/transfer.model.js';
import Branch from '../../modules/commerce/branch/branch.model.js';
import Product from '../../modules/commerce/product/product.model.js';

describe('Inventory E2E - Transfers & Movements', () => {
  let app;
  let adminToken;
  let storeToken;
  let headOffice;
  let subBranch;
  let subBranchTwo;
  let product;

  beforeAll(async () => {
    const { createTestServer } = await import('../helpers/test-utils.js');
    const { createTestUser } = await import('../helpers/test-data.js');

    app = await createTestServer();
    adminToken = (await createTestUser(app, { role: 'admin' })).token;
    storeToken = (await createTestUser(app, { role: 'store-manager' })).token;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await Promise.all([
      StockMovement.deleteMany({}),
      StockEntry.deleteMany({}),
      Transfer.deleteMany({}),
      Product.deleteMany({}),
      Branch.deleteMany({}),
    ]);

    const { createTestBranch, createTestProduct, createTestStockEntry } = await import('../helpers/test-data.js');

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

    subBranchTwo = await Branch.create(createTestBranch({
      code: 'SUB2',
      name: 'Sub Branch 2',
      role: 'sub_branch',
      type: 'store',
      isDefault: false,
    }));

    product = await Product.create(createTestProduct());

    await StockEntry.create(createTestStockEntry(product._id, headOffice._id, {
      quantity: 20,
      costPrice: 300,
    }));

    await StockEntry.create(createTestStockEntry(product._id, subBranch._id, {
      quantity: 10,
      costPrice: 320,
    }));
  });

  it('creates head-office transfer and completes workflow', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 5 }],
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const createBody = createResponse.json();
    if (createBody?.success === false) {
      throw new Error(`Create transfer failed: ${JSON.stringify(createBody)}`);
    }
    const transfer = createBody?.data || createBody;
    const transferId = transfer?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });
    expect(approveResponse.statusCode).toBe(200);

    const dispatchResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });
    expect(dispatchResponse.statusCode).toBe(200);

    const receiveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'receive' },
    });
    expect(receiveResponse.statusCode).toBe(200);

    const subEntry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(subEntry.quantity).toBe(15);

    const transferOut = await StockMovement.findOne({
      'reference.model': 'Challan',
      'reference.id': new mongoose.Types.ObjectId(transferId),
      branch: headOffice._id,
      type: 'transfer_out',
    });
    expect(transferOut).toBeTruthy();

    const transferIn = await StockMovement.findOne({
      'reference.model': 'Challan',
      'reference.id': new mongoose.Types.ObjectId(transferId),
      branch: subBranch._id,
      type: 'transfer_in',
    });
    expect(transferIn).toBeTruthy();
  });

  it('allows sub-branch to sub-branch transfer for admin', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        senderBranchId: subBranch._id,
        receiverBranchId: subBranchTwo._id,
        items: [{ productId: product._id, quantity: 3 }],
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const createBody = createResponse.json();
    if (createBody?.success === false) {
      throw new Error(`Create transfer failed: ${JSON.stringify(createBody)}`);
    }
    const transfer = createBody?.data || createBody;
    const transferId = transfer?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }
    expect(transfer?.transferType).toBe('sub_to_sub');

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'receive' },
    });

    const senderEntry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    const receiverEntry = await StockEntry.findOne({ product: product._id, branch: subBranchTwo._id });
    expect(senderEntry.quantity).toBe(7);
    expect(receiverEntry.quantity).toBe(3);
  });

  it('allows sub-branch return to head office for admin', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        senderBranchId: subBranch._id,
        receiverBranchId: headOffice._id,
        items: [{ productId: product._id, quantity: 2 }],
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const createBody = createResponse.json();
    if (createBody?.success === false) {
      throw new Error(`Create transfer failed: ${JSON.stringify(createBody)}`);
    }
    const transfer = createBody?.data || createBody;
    const transferId = transfer?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }
    expect(transfer?.transferType).toBe('sub_to_head');

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'receive' },
    });

    const headEntry = await StockEntry.findOne({ product: product._id, branch: headOffice._id });
    expect(headEntry.quantity).toBe(22);
  });

  it('supports multi-step partial receive without double-adding stock', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 10 }],
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const transferId = createResponse.json().data?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });

    // Receive 4 now (partial)
    const receivePartial = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        action: 'receive',
        items: [{ productId: product._id.toString(), quantityReceived: 4 }],
      },
    });
    expect(receivePartial.statusCode).toBe(200);

    const entryAfterPartial = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(entryAfterPartial.quantity).toBe(14); // 10 initial + 4 received

    // Receive remaining 6 in a second call (complete)
    const receiveRemaining = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        action: 'receive',
        items: [{ productId: product._id.toString(), quantityReceived: 6 }],
      },
    });
    expect(receiveRemaining.statusCode).toBe(200);

    const finalEntry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(finalEntry.quantity).toBe(20); // 10 initial + 10 total received

    // Ensure movements exist for both receipts (same challan reference)
    const movements = await StockMovement.find({
      'reference.model': 'Challan',
      'reference.id': new mongoose.Types.ObjectId(transferId),
      branch: subBranch._id,
      type: 'transfer_in',
    }).lean();
    expect(movements.length).toBe(2);
    expect(movements.reduce((sum, m) => sum + (m.quantity || 0), 0)).toBe(10);
  });

  it('rejects transfer creation for store-manager', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${storeToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects approval for store-manager', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 2 }],
      },
    });

    const transferId = createResponse.json().data?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${storeToken}` },
      payload: { action: 'approve' },
    });

    expect(approveResponse.statusCode).toBe(403);
  });

  it('rejects dispatch before approval', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 2 }],
      },
    });

    const transferId = createResponse.json().data?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    const dispatchResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });

    expect(dispatchResponse.statusCode).toBe(400);
  });

  it('rejects cancel after dispatch', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 2 }],
      },
    });

    const transferId = createResponse.json().data?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'dispatch' },
    });

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'cancel', reason: 'Test' },
    });

    expect(cancelResponse.statusCode).toBe(400);
  });

  it('fails approval when stock is insufficient', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        receiverBranchId: subBranch._id,
        items: [{ productId: product._id, quantity: 999 }],
      },
    });

    const transferId = createResponse.json().data?._id;
    if (!transferId) {
      throw new Error(`Unexpected create response: ${createResponse.body}`);
    }

    const approveResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${transferId}/action`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { action: 'approve' },
    });

    expect(approveResponse.statusCode).toBe(400);
  });

  it('prevents sub-branch stock increase via adjustments for store-manager', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      headers: { Authorization: `Bearer ${storeToken}` },
      payload: {
        productId: product._id,
        quantity: 25,
        mode: 'set',
        branchId: subBranch._id.toString(),
        reason: 'recount',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    const entry = await StockEntry.findOne({ product: product._id, branch: subBranch._id });
    expect(entry.quantity).toBe(10);
    const failedCount = body?.data?.failed ?? body?.data?.results?.failed?.length ?? 0;
    expect(failedCount).toBe(1);
  });
});
