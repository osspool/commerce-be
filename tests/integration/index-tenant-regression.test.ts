/**
 * Index + Tenant Injection Regression Tests
 *
 * Guards against bugs found during the injectTenantField migration:
 *   1. Tenant field must exist on schema even when multiTenant: false
 *   2. Indexes must be prepended with scope field when scoped
 *   3. Global indexes (idempotencyKey, publicId) must NOT get prepended
 *   4. autoIndex: false must prevent auto-index build
 *   5. syncIndexes() must explicitly build all declared indexes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet;

function freshConn() {
  return mongoose.createConnection(replSet.getUri());
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
}, 30_000);

afterAll(async () => {
  await replSet?.stop();
});

// ─── Order Package ──────────────────────────────────────────────

describe('Order — injectTenantField', () => {
  it('multiTenant: false still adds organizationId field (optional)', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createOrderModels } = await import('@classytic/order');
      const models = createOrderModels(conn, {
        tenantFieldType: 'objectId', multiTenant: false,
      });

      const orgPath = models.Order.schema.path('organizationId');
      expect(orgPath).toBeDefined();
      expect(orgPath.isRequired).toBeFalsy();
    } finally {
      await conn.close();
    }
  });

  it('multiTenant: true makes organizationId required + prepends indexes', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createOrderModels } = await import('@classytic/order');
      const models = createOrderModels(conn, {
        tenantFieldType: 'objectId', multiTenant: true,
      });

      const orgPath = models.Order.schema.path('organizationId');
      expect(orgPath).toBeDefined();
      expect(orgPath.isRequired).toBeTruthy();

      const indexes = models.Order.schema.indexes();
      const statusIndex = indexes.find(([fields]) =>
        'status' in fields && 'organizationId' in fields,
      );
      expect(statusIndex).toBeDefined();
      expect(Object.keys(statusIndex![0])[0]).toBe('organizationId');
    } finally {
      await conn.close();
    }
  });

  it('multiTenant: false does NOT prepend organizationId to compound indexes', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createOrderModels } = await import('@classytic/order');
      const models = createOrderModels(conn, {
        tenantFieldType: 'objectId', multiTenant: false,
      });

      const indexes = models.Order.schema.indexes();
      const statusIndex = indexes.find(([fields]) =>
        'status' in fields && !('organizationId' in fields),
      );
      expect(statusIndex).toBeDefined();
    } finally {
      await conn.close();
    }
  });

  it('autoIndex: false disables auto-index on all models', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createOrderModels } = await import('@classytic/order');
      const models = createOrderModels(conn, {
        tenantFieldType: 'objectId', multiTenant: true,
        autoIndex: false,
      });

      expect(models.Order.schema.get('autoIndex')).toBe(false);
      expect(models.Fulfillment.schema.get('autoIndex')).toBe(false);
    } finally {
      await conn.close();
    }
  });
});

// ─── Revenue Package ────────────────────────────────────────────

describe('Revenue — global vs scoped indexes', () => {
  it('scoped: global indexes (idempotencyKey, publicId, gateway.sessionId) stay unscoped', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createRevenue } = await import('@classytic/revenue');
      const engine = await createRevenue({ connection: conn, defaultCurrency: 'BDT', multiTenant: true });

      const indexes = engine.models.Transaction.schema.indexes();

      const idempotencyIdx = indexes.find(([f]) => 'idempotencyKey' in f);
      expect(idempotencyIdx).toBeDefined();
      expect(Object.keys(idempotencyIdx![0])).not.toContain('organizationId');

      const publicIdIdx = indexes.find(([f]) => 'publicId' in f);
      expect(publicIdIdx).toBeDefined();
      expect(Object.keys(publicIdIdx![0])).not.toContain('organizationId');

      const sessionIdx = indexes.find(([f]) => 'gateway.sessionId' in f);
      expect(sessionIdx).toBeDefined();
      expect(Object.keys(sessionIdx![0])).not.toContain('organizationId');

      await engine.destroy();
    } finally {
      await conn.close();
    }
  });

  it('scoped: domain indexes (status, customerId) get organizationId prefix', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createRevenue } = await import('@classytic/revenue');
      const engine = await createRevenue({ connection: conn, defaultCurrency: 'BDT', multiTenant: true });

      const indexes = engine.models.Transaction.schema.indexes();
      const statusIdx = indexes.find(([f]) => 'status' in f && 'organizationId' in f);
      expect(statusIdx).toBeDefined();
      expect(Object.keys(statusIdx![0])[0]).toBe('organizationId');

      await engine.destroy();
    } finally {
      await conn.close();
    }
  });

  it('unscoped: domain indexes have no organizationId prefix', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createRevenue } = await import('@classytic/revenue');
      const engine = await createRevenue({ connection: conn, defaultCurrency: 'BDT', multiTenant: false });

      const indexes = engine.models.Transaction.schema.indexes();
      const statusIdx = indexes.find(([f]) => 'status' in f);
      expect(statusIdx).toBeDefined();
      expect(Object.keys(statusIdx![0])).not.toContain('organizationId');

      await engine.destroy();
    } finally {
      await conn.close();
    }
  });
});

// ─── Flow Package ───────────────────────────────────────────────

describe('Flow — syncIndexes + ensureFlowReady', () => {
  it('syncIndexes() builds indexes explicitly', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createFlowEngine, ensureFlowReady } = await import('@classytic/flow');
      const flow = createFlowEngine({
        mongoose: conn,
        mode: 'simple',
        catalog: { resolve: async () => null, resolveMany: async () => new Map() } as never,
      });

      await ensureFlowReady(flow, { skipIndexes: true });
      await flow.syncIndexes();

      const quantIndexes = await flow.models.StockQuant.collection.indexes();
      const compoundIndexes = quantIndexes.filter((idx: { name: string }) => idx.name !== '_id_');
      expect(compoundIndexes.length).toBeGreaterThan(0);

      await flow.destroy();
    } finally {
      await conn.close();
    }
  }, 30_000);

  it('ensureFlowReady({ skipIndexes: true }) creates collections but skips index build', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createFlowEngine, ensureFlowReady } = await import('@classytic/flow');
      const flow = createFlowEngine({
        mongoose: conn,
        mode: 'simple',
        catalog: { resolve: async () => null, resolveMany: async () => new Map() } as never,
      });

      await ensureFlowReady(flow, { skipIndexes: true });

      const collections = await conn.db.listCollections().toArray();
      expect(collections.length).toBeGreaterThan(0);

      await flow.destroy();
    } finally {
      await conn.close();
    }
  }, 30_000);
});

// ─── Cross-package: payment verification scoping ────────────────

describe('Payment verification — multiTenant: false still works', () => {
  it('order.confirmPayment() finds the order by orderNumber + organizationId when field exists but is optional', async () => {
    const conn = freshConn();
    await conn.asPromise();
    try {
      const { createOrder } = await import('@classytic/order');
      const engine = await createOrder({
        connection: conn,
        defaultCurrency: 'BDT',
        multiTenant: false,
        tenantFieldType: 'objectId',
        bridges: {
          catalog: {
            resolveLines: async (lines: { sku: string }[]) =>
              lines.map(l => ({
                offerId: l.sku, productId: l.sku, sku: l.sku,
                name: `Product ${l.sku}`, unitPrice: 1000, currency: 'BDT',
                requiresShipping: true,
              })),
          } as never,
        },
      });

      const orgId = new mongoose.Types.ObjectId();

      const order = await engine.repositories.order.create(
        {
          orderType: 'standard',
          channel: 'web',
          organizationId: orgId,
          customerId: 'cust-1',
          customerSnapshot: { name: 'Test', email: 'test@test.com' },
          actorRef: 'test',
          actorKind: 'system',
          currency: 'BDT',
          placedAt: new Date(),
          lines: [{
            lineId: 'l1',
            kind: 'sku',
            fulfillmentType: 'physical',
            requiresShipping: true,
            snapshot: { sku: 'SKU-1', name: 'Test', unitPrice: 1000, currency: 'BDT', requiresShipping: true },
            quantity: 1,
            unitPrice: { amount: 1000, currency: 'BDT' },
            unitDiscount: { amount: 0, currency: 'BDT' },
            unitTax: { amount: 0, currency: 'BDT' },
            lineTotal: { amount: 1000, currency: 'BDT' },
            subtotal: { amount: 1000, currency: 'BDT' },
            total: { amount: 1000, currency: 'BDT' },
          }],
          totals: {
            subtotal: { amount: 1000, currency: 'BDT' },
            discount: { amount: 0, currency: 'BDT' },
            tax: { amount: 0, currency: 'BDT' },
            shipping: { amount: 0, currency: 'BDT' },
            grandTotal: { amount: 1000, currency: 'BDT' },
          },
          paymentState: {
            authorizeStatus: 'none',
            chargeStatus: 'none',
            totalAuthorized: { amount: 0, currency: 'BDT' },
            totalCharged: { amount: 0, currency: 'BDT' },
            totalRefunded: { amount: 0, currency: 'BDT' },
          },
        } as never,
        { organizationId: orgId.toString() },
      );

      expect(order.orderNumber).toBeDefined();

      const confirmed = await engine.repositories.order.confirmPayment(
        order.orderNumber!,
        {
          chargeStatus: 'full',
          totalCharged: { amount: 1000, currency: 'BDT' },
        } as never,
        {
          organizationId: orgId.toString(),
          actorRef: 'system',
          actorKind: 'system' as const,
          correlationId: 'test',
        },
      );

      const ps = (confirmed as { paymentState: { chargeStatus: string } }).paymentState;
      expect(ps.chargeStatus).toBe('full');
    } finally {
      await conn.close();
    }
  }, 30_000);
});
