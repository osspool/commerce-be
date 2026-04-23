/**
 * Order Engine Singleton
 *
 * Lazy-initializes @classytic/order on the default mongoose connection.
 * Same pattern as catalog.engine.ts and flow-engine.ts.
 *
 * Shares Arc's event transport — Arc's MemoryEventTransport structurally
 * satisfies Order's EventTransport, so order events land on the same
 * bus as all other Arc events. No bridge adapter needed.
 */

import type { EventTransport, OrderEngine } from '@classytic/order';
import { createOrder } from '@classytic/order';
import mongoose from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';
import { wireShiftAggregationHook } from '#resources/sales/pos/shift-aggregation.hook.js';
import { createCatalogBridge } from './bridges/catalog.bridge.js';
import { createFlowBridge } from './bridges/flow.bridge.js';
import { createRevenueBridge } from './bridges/revenue.bridge.js';
import { wireOrderRevenueHook } from './order-revenue-hook.js';
import { wireOrderStockHook } from './order-stock-hook.js';

let engine: OrderEngine | null = null;
let pending: Promise<OrderEngine> | null = null;

/**
 * Get or lazily create the order engine.
 *
 * Multi-tenant scoping is enforced at the Arc layer via the `orgScoped`
 * preset on each orders resource (see be-prod's AGENTS.md — Arc is the
 * canonical tenant boundary for every resource in this project). We
 * therefore opt OUT of `@classytic/order`'s repository-level auto-wired
 * `multiTenantPlugin` with `multiTenant: false` to avoid double-scoping
 * that would fight the preset: the mongokit plugin wants
 * `ctx.organizationId` on every call, while Arc's preset merges tenant
 * filters into `_policyFilters` instead of passing them down the call
 * chain. Arc's scope is the single source of truth.
 *
 * Bridges: catalog required; revenue/flow wired later as needed.
 */
export async function ensureOrderEngine(): Promise<OrderEngine> {
  if (engine) return engine;

  if (!pending) {
    pending = (async () => {
      engine = await createOrder({
        connection: mongoose.connection,
        defaultCurrency: 'BDT',
        multiTenant: false,
        autoIndex: process.env.NODE_ENV !== 'production',

        // Better Auth stores organization._id as ObjectId — match the schema so
        // $lookup, .populate('organizationId'), and QueryParser `?lookup=organizationId`
        // work across the orders → organization boundary.
        tenantFieldType: 'objectId',

        bridges: {
          catalog: createCatalogBridge(),
          // Flow bridge protects against overselling: /orders/place reserves
          // stock atomically before persisting the order, so two concurrent
          // requests for the last unit can never both succeed. See
          // bridges/flow.bridge.ts and orders-concurrency-e2e.test.ts.
          flow: createFlowBridge(),
          // Revenue bridge — payment intents, immediate verification,
          // refunds, escrow. All methods resolve the revenue engine
          // lazily per-call, so boot order with `revenue.plugin` doesn't
          // matter; the revenue engine just has to be initialized before
          // the first order-pipeline payment op fires.
          revenue: createRevenueBridge(),
        },

        // Share Arc's event transport directly
        eventTransport: eventTransport as unknown as EventTransport,

        idPrefixes: { order: 'ORD', fulfillment: 'FUL', orderChange: 'CHG', quotation: 'QUO' },
        idPartition: 'yearly',

        // Quotation module — enables B2B sales quote → order conversion
        // (engine.repositories.quotation + engine.models.Quotation).
        // See be-prod/src/resources/sales/quotations/quotation.resource.ts.
        modules: { quotation: true },
      });

      // ─── Idempotency: unique partial index on metadata.idempotencyKey ──
      //
      // @classytic/order defines `IdempotencyConflictError` + the VO/entity
      // but explicitly leaves idempotency STORAGE to the host (its CLAUDE.md
      // §"Durable outbox storage and idempotency records are NOT owned by
      // this package"). We stamp the key into `metadata.idempotencyKey` on
      // create and rely on a partial unique index to serialize races — the
      // same defense-in-depth pattern used for accounting journal entries.
      //
      // Partial filter uses `$type: 'string'` (NOT `$ne: null`) — MongoDB
      // rejects `$ne` inside partialFilterExpression, which is why the
      // ledger's own idempotency index is silently broken.
      {
        const orderModel = engine.models.Order;
        orderModel.schema.index(
          { organizationId: 1, 'metadata.idempotencyKey': 1 },
          {
            unique: true,
            partialFilterExpression: {
              'metadata.idempotencyKey': { $type: 'string' },
            },
            name: 'metadata_idempotencyKey_unique',
          },
        );
      }

      await engine.syncIndexes();

      // Wire the order→revenue auto-bridge. Subscribes once to the order
      // repo's `after:create` so EVERY create path (Arc CRUD storefront,
      // POS terminal, custom /place) gets a matching revenue.transaction
      // record. See order-revenue-hook.ts for the routing rules.
      wireOrderRevenueHook(engine);

      // Wire the order→flow stock auto-bridge. Goods-leave-on-sale channels
      // (POS) decrement stock immediately at order-create time because the
      // customer walks out with the product. Web / marketplace orders are
      // untouched — they reserve at place-time and decrement on fulfillment
      // ship. See order-stock-hook.ts.
      wireOrderStockHook(engine);

      // Wire the order→POS-shift aggregation bridge. POS orders increment the
      // active shift's salesCount/salesTotal + per-method paymentBreakdown
      // atomically via $inc. See shift-aggregation.hook.ts.
      wireShiftAggregationHook(engine);

      return engine;
    })();
  }

  return pending;
}

/** Tear down — tests only. */
export async function destroyOrderEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
    pending = null;
  }
}
