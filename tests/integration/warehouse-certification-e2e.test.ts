/**
 * Warehouse Certification E2E
 *
 * Certification-style coverage for the branch-scoped warehouse model.
 *
 * This suite answers the business questions directly:
 * 1. Stock can be added without choosing a warehouse because each branch auto-gets
 *    a default warehouse node and `stock` location.
 * 2. In standard mode, that default warehouse is the only warehouse per branch.
 * 3. Supplier purchases are head-office only and receipt lands in the default stock location.
 * 4. Branch-to-branch stock movement happens through transfer actions, not direct stock edits.
 *
 * Two-admin setup: HO admin + sub-branch admin are distinct users, each a
 * member of only their own org. This preserves the "sub-branch cannot
 * record supplier purchases" 403 contract that `addSecondaryBranch`
 * (single shared admin) would collapse.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '@classytic/arc/testing';
import {
  bootScenarioApp,
  addSecondaryBranchWithOwnAdmin,
  type ScenarioEnv,
} from '../helpers/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let server: FastifyInstance;
let flow: Awaited<
  ReturnType<typeof import('../../src/resources/inventory/flow/flow-engine.js')>
>['getFlowEngine'] extends () => infer T
  ? T
  : never;

let hoAuth: AuthProvider;
let hoOrgId: string;
let subAuth: AuthProvider;
let subOrgId: string;

let simpleProductId: string;
let purchaseProductId: string;
let variantProductId: string;

const CERT_TRANSFER_SKU = 'CERT-RED-M';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedProducts(): Promise<void> {
  const products = mongoose.connection.db!.collection('catalog_products');

  const simpleResult = await products.insertOne({
    _id: new mongoose.Types.ObjectId(),
    name: 'Certification Stock Product',
    slug: `cert-stock-${Date.now()}`,
    basePrice: 1000,
    costPrice: 400,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'cert-category',
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
  simpleProductId = String(simpleResult.insertedId);

  const purchaseResult = await products.insertOne({
    _id: new mongoose.Types.ObjectId(),
    name: 'Certification Purchase Product',
    slug: `cert-purchase-${Date.now()}`,
    basePrice: 800,
    costPrice: 250,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'cert-category',
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
  purchaseProductId = String(purchaseResult.insertedId);

  const variantResult = await products.insertOne({
    _id: new mongoose.Types.ObjectId(),
    name: 'Certification Variant Product',
    slug: `cert-variant-${Date.now()}`,
    basePrice: 1500,
    costPrice: 700,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'cert-category',
    parentCategory: null,
    images: [],
    variationAttributes: [
      { code: 'color', name: 'Color', values: [{ code: 'red', label: 'Red' }] },
      { code: 'size', name: 'Size', values: [{ code: 'm', label: 'M' }] },
    ],
    variants: [
      {
        sku: CERT_TRANSFER_SKU,
        attributes: { color: 'Red', size: 'M' },
        priceModifier: 0,
        costPrice: 700,
        images: [],
        isActive: true,
        vatRate: null,
      },
    ],
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
  variantProductId = String(variantResult.insertedId);
}

function injectAs(auth: AuthProvider, method: string, url: string, payload?: unknown) {
  return server.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: `${API}${url}`,
    headers: auth.getHeaders('admin'),
    ...(payload ? { payload } : {}),
  });
}

async function getAvailability(auth: AuthProvider, skuRef: string) {
  const res = await injectAs(auth, 'GET', `/inventory/availability?skuRef=${encodeURIComponent(skuRef)}`);
  return { statusCode: res.statusCode, body: parse(res.body) };
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'ho-cert',
    env: { FLOW_MODE: 'standard' },
    extraOrgUpdate: { code: 'HO-CERT', branchType: 'warehouse', branchRole: 'head_office' },
  });
  server = env.server;
  hoOrgId = env.orgId;

  // Nodes + reports need superadmin; bootScenarioApp gives plain admin.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: env.ctx.users.admin.email },
    { $set: { role: ['superadmin'] } },
  );
  hoAuth = env.auth;

  const sub = await addSecondaryBranchWithOwnAdmin(env, {
    slug: 'sub-cert',
    name: 'Sub Branch Certification',
    branchRole: 'sub_branch',
    branchType: 'store',
    roles: ['superadmin'],
  });
  subAuth = sub.auth;
  subOrgId = sub.orgId;

  await seedProducts();

  const flowMod = await import('../../src/resources/inventory/flow/flow-engine.js');
  flow = flowMod.getFlowEngine();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Warehouse Certification', () => {
  it('auto-creates and uses the default warehouse when stock is added without selecting a warehouse', async () => {
    const nodesRes = await injectAs(hoAuth, 'GET', '/inventory/nodes');
    expect(nodesRes.statusCode).toBe(200);
    const nodesBody = parse(nodesRes.body);
    expect(Array.isArray(nodesBody?.data)).toBe(true);
    expect(nodesBody.data.length).toBeGreaterThan(0);

    const hoCtx = { organizationId: hoOrgId, actorId: 'cert' };
    const defaultNode = await flow.repositories.node.getByQuery({ isDefault: true }, { organizationId: hoCtx.organizationId, throwOnNotFound: false, lean: true });
    expect(defaultNode).toBeTruthy();

    const locations = await flow.repositories.location.findAll(
      { nodeId: String(defaultNode!._id) },
      { organizationId: hoCtx.organizationId, sort: { sortOrder: 1 } },
    );
    const codes = new Set(locations.map((location) => location.code));
    expect(codes.has('stock')).toBe(true);
    expect(codes.has('vendor')).toBe(true);
    expect(codes.has('customer')).toBe(true);
    expect(codes.has('adjustment')).toBe(true);

    const adjustRes = await injectAs(hoAuth, 'POST', '/inventory/adjustments', {
      productId: simpleProductId,
      quantity: 40,
      mode: 'set',
      reason: 'Certification seed without explicit warehouse',
    });
    expect(adjustRes.statusCode).toBe(200);
    const adjustBody = parse(adjustRes.body);
    expect(adjustBody?.success).toBe(true);
    expect(adjustBody?.data?.newQuantity).toBe(40);

    const availability = await getAvailability(hoAuth, simpleProductId);
    expect(availability.statusCode).toBe(200);
    expect(availability.body?.data?.quantityOnHand).toBe(40);
    expect(availability.body?.data?.quantityAvailable).toBe(40);
  });

  it('rejects creating a second warehouse for the branch in standard mode', async () => {
    const createNodeRes = await injectAs(hoAuth, 'POST', '/inventory/nodes', {
      code: 'OVERFLOW',
      name: 'Overflow Warehouse',
      type: 'warehouse',
      isDefault: false,
    });
    expect(createNodeRes.statusCode).toBe(400);
    expect(parse(createNodeRes.body)?.error || parse(createNodeRes.body)?.message).toContain(
      'Only 1 warehouse allowed',
    );
  });

  it('receives supplier purchase into the head-office default warehouse', async () => {
    const createPurchaseRes = await injectAs(hoAuth, 'POST', '/inventory/purchase-orders', {
      branchId: hoOrgId,
      items: [{ productId: purchaseProductId, quantity: 15, costPrice: 250 }],
      notes: 'Certification purchase receipt',
    });
    expect(createPurchaseRes.statusCode).toBe(201);
    const purchaseId = parse(createPurchaseRes.body)?.data?._id;
    expect(typeof purchaseId).toBe('string');

    const receivePurchaseRes = await injectAs(
      hoAuth,
      'POST',
      `/inventory/purchase-orders/${purchaseId}/action`,
      { action: 'receive' },
    );
    expect(receivePurchaseRes.statusCode).toBe(200);
    expect(parse(receivePurchaseRes.body)?.data?.status).toBe('received');

    const availability = await getAvailability(hoAuth, purchaseProductId);
    expect(availability.statusCode).toBe(200);
    expect(availability.body?.data?.quantityOnHand).toBe(15);
    expect(availability.body?.data?.quantityAvailable).toBe(15);
  });

  it('rejects supplier purchase documents for a sub-branch', async () => {
    const createPurchaseRes = await injectAs(subAuth, 'POST', '/inventory/purchase-orders', {
      branchId: subOrgId,
      items: [{ productId: purchaseProductId, quantity: 5, costPrice: 250 }],
      notes: 'Sub-branch purchase must be rejected',
    });
    expect(createPurchaseRes.statusCode).toBe(403);
    expect(parse(createPurchaseRes.body)?.error || parse(createPurchaseRes.body)?.message).toContain(
      'Purchases can only be recorded at head office',
    );
  });

  it('moves stock between branches through the transfer lifecycle and preserves in-transit timing', async () => {
    const stockSeedRes = await injectAs(hoAuth, 'POST', '/inventory/adjustments', {
      productId: variantProductId,
      variantSku: CERT_TRANSFER_SKU,
      quantity: 25,
      mode: 'set',
      reason: 'Certification transfer seed',
    });
    expect(stockSeedRes.statusCode).toBe(200);
    expect(parse(stockSeedRes.body)?.data?.newQuantity).toBe(25);

    const createTransferRes = await injectAs(hoAuth, 'POST', '/inventory/transfers', {
      senderBranchId: hoOrgId,
      receiverBranchId: subOrgId,
      items: [{ productId: variantProductId, variantSku: CERT_TRANSFER_SKU, quantity: 10 }],
      remarks: 'Certification branch transfer',
    });
    expect(createTransferRes.statusCode).toBe(201);
    const transferId = parse(createTransferRes.body)?.data?._id;
    expect(typeof transferId).toBe('string');

    const approveRes = await injectAs(hoAuth, 'POST', `/inventory/transfers/${transferId}/action`, {
      action: 'approve',
    });
    expect(approveRes.statusCode).toBe(200);
    expect(parse(approveRes.body)?.data?.status).toBe('approved');

    const dispatchRes = await injectAs(hoAuth, 'POST', `/inventory/transfers/${transferId}/action`, {
      action: 'dispatch',
    });
    expect(dispatchRes.statusCode).toBe(200);
    expect(parse(dispatchRes.body)?.data?.status).toBe('dispatched');

    const hoAfterDispatch = await getAvailability(hoAuth, CERT_TRANSFER_SKU);
    const subAfterDispatch = await getAvailability(subAuth, CERT_TRANSFER_SKU);
    expect(hoAfterDispatch.body?.data?.quantityOnHand).toBe(15);
    expect(subAfterDispatch.body?.data?.quantityOnHand).toBe(0);

    const receiveRes = await injectAs(subAuth, 'POST', `/inventory/transfers/${transferId}/action`, {
      action: 'receive',
      items: [{ productId: variantProductId, variantSku: CERT_TRANSFER_SKU, quantityReceived: 10 }],
    });
    expect(receiveRes.statusCode).toBe(200);
    expect(['received', 'partial_received']).toContain(parse(receiveRes.body)?.data?.status);

    const hoAfterReceive = await getAvailability(hoAuth, CERT_TRANSFER_SKU);
    const subAfterReceive = await getAvailability(subAuth, CERT_TRANSFER_SKU);
    expect(hoAfterReceive.body?.data?.quantityOnHand).toBe(15);
    expect(subAfterReceive.body?.data?.quantityOnHand).toBe(10);
  });
});
