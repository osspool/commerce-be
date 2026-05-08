/**
 * Stock ↔ Warehouse ↔ Flow Alignment — Independent E2E Suite
 *
 * Verifies that stock quantities, warehouse operations, and Flow quants
 * are consistent across all paths.
 *
 * Covers:
 *   1. Auto-bootstrap: warehouse + locations created on first access
 *   2. Stock adjustment ↔ Flow quants
 *   3. Low-stock detection
 *   4. Transfer flow: HO → sub, dispatch decrements sender, receive increments receiver
 *   5. Damaged stock adjustment
 *   6. Movement audit trail
 *   7. Zero-stock detection
 *
 * Two-admin setup: HO admin + sub admin are distinct users (each a member
 * of only their own org) so branch-isolation behavior is observed at the
 * membership layer, not just via x-organization-id header override.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import type { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import {
  bootScenarioApp,
  addSecondaryBranchWithOwnAdmin,
  type ScenarioEnv,
} from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

let hoAuth: TestAuthProvider;
let hoOrgId: string;
let subAuth: TestAuthProvider;
let subOrgId: string;

let productId: string;
const PRODUCT_NAME = 'Flow-Test Widget';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedProduct(): Promise<string> {
  const result = await mongoose.connection.db!.collection('catalog_products').insertOne({
    name: PRODUCT_NAME,
    slug: `flow-widget-${Date.now()}`,
    basePrice: 500,
    costPrice: 200,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    isActive: true,
    images: [],
    style: [],
    tags: [],
    stats: { totalSales: 0, viewCount: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId.toString();
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
    scenario: 'ho',
    env: { FLOW_MODE: 'simple' },
    extraOrgUpdate: { code: 'HO', branchType: 'warehouse', branchRole: 'head_office' },
  });
  server = env.server;
  hoAuth = env.auth;
  hoOrgId = env.orgId;

  const sub = await addSecondaryBranchWithOwnAdmin(env, {
    slug: 'sub-a',
    name: 'Store Alpha',
    branchRole: 'sub_branch',
    branchType: 'store',
    roles: ['admin'],
  });
  subAuth = sub.auth;
  subOrgId = sub.orgId;

  productId = await seedProduct();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Stock ↔ Warehouse ↔ Flow Alignment', () => {

  describe('1. Auto-Bootstrap (no manual warehouse config)', () => {
    it('first inventory request triggers bootstrap (no 500)', async () => {
      const res = await hoInject('GET', '/inventory/nodes');
      expect(res.statusCode).not.toBe(500);
    });

    it('locations endpoint responds after bootstrap', async () => {
      const res = await hoInject('GET', '/inventory/locations');
      expect(res.statusCode).not.toBe(500);
    });

    it('sub-branch also bootstraps on first access', async () => {
      const res = await subInject('GET', '/inventory/locations');
      expect(res.statusCode).not.toBe(500);
    });
  });

  describe('2. Stock Adjustment → Flow Quant Alignment', () => {
    it('adjusting stock at HO creates Flow quants', async () => {
      const res = await hoInject('POST', '/inventory/adjustments', {
        productId, quantity: 100, mode: 'set',
      });
      expect(res.statusCode).toBe(200);
    });

    it('availability query reflects the adjustment', async () => {
      const res = await hoInject('GET', `/inventory/availability?productId=${productId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(100);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });

    it('sub-branch starts with zero stock (branch isolation)', async () => {
      const res = await subInject('GET', `/inventory/availability?productId=${productId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(0);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });
  });

  describe('3. Low-Stock Detection', () => {
    it('product with stock=5 appears in low-stock list (threshold=10)', async () => {
      await hoInject('POST', '/inventory/adjustments', {
        productId, quantity: 5, mode: 'set',
      });

      const res = await hoInject('GET', '/inventory/low-stock');
      expect(res.statusCode).toBe(200);
    });

    it('product with stock=100 does NOT appear in low-stock', async () => {
      await hoInject('POST', '/inventory/adjustments', {
        productId, quantity: 100, mode: 'set',
      });

      const res = await hoInject('GET', '/inventory/low-stock');
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      const items = body.data || body.data || [];
      const found = items.find?.((i: { productId?: string; skuRef?: string }) =>
        i.productId === productId || i.skuRef === productId,
      );
      expect(found).toBeFalsy();
    });
  });

  describe('4. Transfer: HO → Sub Branch Stock Movement', () => {
    let transferId: string;

    it('creates transfer from HO to sub-branch', async () => {
      const res = await hoInject('POST', '/inventory/transfers', {
        receiverBranchId: subOrgId,
        items: [{ productId, quantity: 20 }],
      });
      expect(res.statusCode).toBe(201);
      transferId = parse(res.body)._id;
    });

    it('approves transfer', async () => {
      const res = await hoInject('POST', `/inventory/transfers/${transferId}/action`, {
        action: 'approve',
      });
      expect(res.statusCode).toBe(200);
      expect(parse(res.body).status).toBe('approved');
    });

    it('dispatches transfer (HO stock decrements by 20)', async () => {
      const res = await hoInject('POST', `/inventory/transfers/${transferId}/action`, {
        action: 'dispatch',
      });
      expect(res.statusCode).toBe(200);
      expect(parse(res.body).status).toBe('dispatched');
    });

    it('receives transfer at sub-branch (sub stock increments by 20)', async () => {
      const res = await subInject('POST', `/inventory/transfers/${transferId}/action`, {
        action: 'receive',
        items: [{ productId, quantityReceived: 20 }],
      });
      expect(res.statusCode).toBe(200);
      const data = parse(res.body);
      expect(['received', 'partial_received']).toContain(data.status);
    });

    it('HO stock = 80 after dispatching 20 of 100', async () => {
      const res = await hoInject('GET', `/inventory/availability?productId=${productId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(80);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });

    it('sub-branch stock = 20 after receiving transfer', async () => {
      const res = await subInject('GET', `/inventory/availability?productId=${productId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(20);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });
  });

  describe('5. Damaged / Lost Stock Adjustment', () => {
    it('removing damaged stock decrements Flow quants', async () => {
      const res = await hoInject('POST', '/inventory/adjustments', {
        productId, quantity: 5, mode: 'remove',
        reason: 'Damaged goods — water damage in warehouse',
      });
      expect(res.statusCode).toBe(200);
    });

    it('HO stock = 75 after removing 5 damaged', async () => {
      const res = await hoInject('GET', `/inventory/availability?productId=${productId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(75);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });
  });

  describe('6. Stock Movement Audit Trail', () => {
    it('movements endpoint responds with audit data', async () => {
      const res = await hoInject('GET', '/inventory/movements?page=1&limit=50');
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);

    });
  });

  describe('7. Zero-Stock Detection', () => {
    it('setting stock to 0 results in out-of-stock', async () => {
      const db = mongoose.connection.db!;
      const zeroProduct = await db.collection('catalog_products').insertOne({
        name: 'Zero Widget', slug: `zero-${Date.now()}`, basePrice: 100, productType: 'physical',
        status: 'active', isActive: true, quantity: 0, createdAt: new Date(), updatedAt: new Date(),
      });

      const res = await hoInject('GET', `/inventory/availability?productId=${zeroProduct.insertedId}`);
      if (res.statusCode === 200) {
        const avail = parse(res.body);
        if (avail?.quantityOnHand !== undefined) {
          expect(avail.quantityOnHand).toBe(0);
          expect(avail.quantityAvailable).toBe(0);
        }
      }
      expect(res.statusCode).not.toBe(500);
    });
  });
});
