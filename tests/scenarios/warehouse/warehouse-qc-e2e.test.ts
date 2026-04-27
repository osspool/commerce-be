/**
 * Warehouse QC E2E
 *
 * Strict end-to-end QC suite for the dynamic warehouse subsystem.
 *
 * Goals:
 * 1. Dynamic bootstrap creates default warehouse + core locations per branch
 * 2. Branch isolation is enforced on availability and reservation endpoints
 * 3. Supplier purchase receipt flows into Flow quants at head office
 * 4. Inter-branch transfer dispatch/receive updates stock in both branches
 *
 * Two-admin setup: HO admin + sub-branch admin are distinct users, each a
 * member of only their own org. This preserves the cross-branch 403
 * isolation contract that `addSecondaryBranch` (single shared admin)
 * would collapse.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import type { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import {
  bootScenarioApp,
  addSecondaryBranchWithOwnAdmin,
  type ScenarioEnv,
} from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let server: FastifyInstance;
let flow: Awaited<ReturnType<typeof import('../../../src/resources/inventory/flow/flow-engine.js')>>['getFlowEngine'] extends () => infer T ? T : never;

let hoAuth: TestAuthProvider;
let hoOrgId: string;
let subAuth: TestAuthProvider;
let subOrgId: string;
let productId: string;
let purchaseId: string;
let transferId: string;

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

function hoInject(method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: `${API}${url}`,
    headers: hoAuth.as('admin').headers,
    ...(payload ? { payload } : {}),
  });
}

function subInject(method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: `${API}${url}`,
    headers: subAuth.as('admin').headers,
    ...(payload ? { payload } : {}),
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'ho-qc',
    env: { FLOW_MODE: 'standard' },
    extraOrgUpdate: { code: 'HO-QC', branchType: 'warehouse', branchRole: 'head_office' },
  });
  server = env.server;
  hoOrgId = env.orgId;

  // HO admin needs superadmin for some inventory node/report routes.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
  hoAuth = env.auth;

  const sub = await addSecondaryBranchWithOwnAdmin(env, {
    slug: 'sub-qc',
    name: 'Sub Branch QC',
    branchRole: 'sub_branch',
    branchType: 'store',
    roles: ['superadmin'],
  });
  subAuth = sub.auth;
  subOrgId = sub.orgId;

  await mongoose.connection.db!.collection('catalog_products').insertOne({
    _id: new mongoose.Types.ObjectId(),
    name: 'Warehouse QC Product',
    slug: `warehouse-qc-product-${Date.now()}`,
    basePrice: 500,
    costPrice: 220,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'qc-category',
    parentCategory: null,
    images: [],
    style: [],
    tags: [],
    stats: { totalSales: 0, totalQuantitySold: 0, viewCount: 0 },
    stockProjection: { variants: [] },
    averageRating: 0,
    numReviews: 0,
    isActive: true,
    vatRate: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const product = await mongoose.connection.db!.collection('catalog_products').findOne(
    { name: 'Warehouse QC Product' },
    { projection: { _id: 1 } },
  );
  productId = String(product!._id);

  const flowMod = await import('../../../src/resources/inventory/flow/flow-engine.js');
  flow = flowMod.getFlowEngine();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Warehouse QC E2E', () => {
  it('auto-bootstraps default warehouse and locations for both branches', async () => {
    const hoNodesRes = await hoInject('GET', '/inventory/nodes');
    expect(hoNodesRes.statusCode).toBe(200);
    const hoNodes = parse(hoNodesRes.body)?.data;
    expect(Array.isArray(hoNodes)).toBe(true);
    expect(hoNodes.length).toBeGreaterThan(0);

    const subNodesRes = await subInject('GET', '/inventory/nodes');
    expect(subNodesRes.statusCode).toBe(200);
    const subNodes = parse(subNodesRes.body)?.data;
    expect(Array.isArray(subNodes)).toBe(true);
    expect(subNodes.length).toBeGreaterThan(0);

    const hoCtx = { organizationId: hoOrgId, actorId: 'qc' };
    const subCtx = { organizationId: subOrgId, actorId: 'qc' };
    const hoNode = await flow.repositories.node.getByQuery({ isDefault: true }, { organizationId: hoCtx.organizationId, throwOnNotFound: false, lean: true });
    const subNode = await flow.repositories.node.getByQuery({ isDefault: true }, { organizationId: subCtx.organizationId, throwOnNotFound: false, lean: true });
    expect(hoNode).toBeTruthy();
    expect(subNode).toBeTruthy();

    const hoLocations = await flow.repositories.location.findAll(
      { nodeId: String(hoNode!._id) },
      { organizationId: hoCtx.organizationId, sort: { sortOrder: 1 } },
    );
    const subLocations = await flow.repositories.location.findAll(
      { nodeId: String(subNode!._id) },
      { organizationId: subCtx.organizationId, sort: { sortOrder: 1 } },
    );
    const hoCodes = new Set(hoLocations.map((l) => l.code));
    const subCodes = new Set(subLocations.map((l) => l.code));

    for (const code of ['stock', 'vendor', 'customer', 'adjustment']) {
      expect(hoCodes.has(code)).toBe(true);
      expect(subCodes.has(code)).toBe(true);
    }
  });

  it('rejects cross-branch availability and reservation requests', async () => {
    const availabilityRes = await subInject(
      'GET',
      `/inventory/availability?skuRef=${productId}&branchId=${hoOrgId}`,
    );
    expect(availabilityRes.statusCode).toBe(403);

    const reservationRes = await subInject('POST', '/inventory/reservations', {
      branchId: hoOrgId,
      reservationType: 'soft',
      ownerType: 'qc',
      ownerId: 'qc-cross-branch',
      skuRef: productId,
      quantity: 1,
    });
    expect(reservationRes.statusCode).toBe(403);
  });

  it('receives a purchase at head office and writes stock into Flow quants', async () => {
    const createRes = await hoInject('POST', '/inventory/purchase-orders', {
      items: [{ productId, quantity: 25, costPrice: 220 }],
      notes: 'Warehouse QC purchase',
    });
    expect(createRes.statusCode).toBe(201);
    purchaseId = parse(createRes.body)?.data?._id;
    expect(typeof purchaseId).toBe('string');

    const receiveRes = await hoInject('POST', `/inventory/purchase-orders/${purchaseId}/action`, {
      action: 'receive',
    });
    expect(receiveRes.statusCode).toBe(200);
    expect(parse(receiveRes.body)?.data?.status).toBe('received');

    const avail = await flow.services.quant.getAvailability(
      { skuRef: productId, locationId: 'stock' },
      { organizationId: hoOrgId, actorId: 'qc' },
    );
    expect(avail.quantityOnHand).toBe(25);
    expect(avail.quantityAvailable).toBe(25);
  });

  it('transfers stock from head office to sub-branch through business actions', async () => {
    const createTransferRes = await hoInject('POST', '/inventory/transfers', {
      receiverBranchId: subOrgId,
      items: [{ productId, quantity: 10 }],
      remarks: 'Warehouse QC transfer',
    });
    expect(createTransferRes.statusCode).toBe(201);
    transferId = parse(createTransferRes.body)?.data?._id;
    expect(typeof transferId).toBe('string');

    const approveRes = await hoInject('POST', `/inventory/transfers/${transferId}/action`, {
      action: 'approve',
    });
    expect(approveRes.statusCode).toBe(200);
    expect(parse(approveRes.body)?.data?.status).toBe('approved');

    const dispatchRes = await hoInject('POST', `/inventory/transfers/${transferId}/action`, {
      action: 'dispatch',
    });
    expect(dispatchRes.statusCode).toBe(200);
    expect(parse(dispatchRes.body)?.data?.status).toBe('dispatched');

    const receiveRes = await subInject('POST', `/inventory/transfers/${transferId}/action`, {
      action: 'receive',
      items: [{ productId, quantityReceived: 10 }],
    });
    expect(receiveRes.statusCode).toBe(200);
    expect(['received', 'partial_received']).toContain(parse(receiveRes.body)?.data?.status);

    const hoAvail = await flow.services.quant.getAvailability(
      { skuRef: productId, locationId: 'stock' },
      { organizationId: hoOrgId, actorId: 'qc' },
    );
    const subAvail = await flow.services.quant.getAvailability(
      { skuRef: productId, locationId: 'stock' },
      { organizationId: subOrgId, actorId: 'qc' },
    );

    expect(hoAvail.quantityOnHand).toBe(15);
    expect(subAvail.quantityOnHand).toBe(10);
  });
});
