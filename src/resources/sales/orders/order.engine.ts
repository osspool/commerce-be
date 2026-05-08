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
import { wireOrderLoyaltyHook } from './order-loyalty-hook.js';
import { wireOrderRevenueHook } from './order-revenue-hook.js';
import { wireOrderLifecycleHandlers } from './lifecycle/wire-handlers.js';
import { wireOrderStockHook } from './order-stock-hook.js';
import { shouldAutoIndex } from '#shared/db/auto-index.js';

let engine: OrderEngine | null = null;
let pending: Promise<OrderEngine> | null = null;

/**
 * Get or lazily create the order engine.
 *
 * Branch scoping (multi-branch isolation in this single-business ERP, where
 * `organizationId === branchId`) is enforced through TWO layers, both of
 * which are required for full coverage:
 *
 *   1. **Arc preset (`orgScoped`)** — covers the CRUD path. The
 *      `multiTenantPreset` middleware sets `req._tenantFields` so
 *      `BaseCrudController.tenantRepoOptions(req)` forwards
 *      `organizationId` to `repo.getAll(...)` / `repo.getById(...)` etc.
 *      No mongokit plugin is required for CRUD because the controller
 *      stamps the orgId into the call options directly.
 *
 *   2. **Mongokit's `multiTenantPlugin`** — covers the AGGREGATION path.
 *      Arc 2.15.2+ explicitly delegates tenant-scope injection on
 *      aggregations to the kit's plugin (see arc's
 *      `core/aggregation/validate.ts` — type-coercion lives in the kit,
 *      not the framework). Without the plugin, `repo.aggregate(req,
 *      { organizationId })` reaches `executeAgg()` with NO tenant clause
 *      and returns every branch's rows. That breaks per-branch sales
 *      dashboards, which would otherwise show another branch's orders to
 *      a sub-branch operator.
 *
 * Pre-arc-2.15.2 we ran with `multiTenant: false` to "avoid double-scoping
 * that would fight the preset". That was correct for the CRUD path but
 * silently broke aggregations once arc removed its inline tenant-filter
 * injection. Re-enabled: `tenantFieldType: 'objectId'` matches Better
 * Auth's storage type, so the plugin's auto-cast produces a
 * filter-compatible `ObjectId` clause that the IR pipeline composes
 * cleanly with arc's controller-level orgId option.
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
        // Branch isolation on the AGGREGATION path requires this plugin —
        // arc's CRUD path scopes via the orgScoped preset, but
        // /aggregations/:name routes go through mongokit's
        // `before:aggregate` hook and need the plugin installed to read
        // `context.organizationId` and inject the `$match`.
        //
        // `required: false` is critical here because the SAME order repo
        // backs TWO arc resources:
        //   1. `order` resource (per-branch, `presets: [orgScoped]`,
        //      `tenantField: 'organizationId'`) — arc forwards orgId via
        //      `tenantRepoOptions`, plugin reads it, scope applied.
        //   2. `salesOverview` admin resource (cross-branch HQ rollup,
        //      `tenantField: false`) — arc deliberately does NOT forward
        //      orgId. With `required: true` (default) the plugin would
        //      throw "Missing organizationId in context"; `required: false`
        //      lets the unscoped query pass through to roll up across
        //      every branch.
        // Per-branch leakage is still impossible because BaseCrudController
        // unconditionally calls `tenantRepoOptions(req)` on every CRUD +
        // aggregate call for the orgScoped resource — orgId is always
        // forwarded for that resource. `required: false` only relaxes the
        // hard-throw on truly cross-branch endpoints that opt out via
        // `tenantField: false`.
        multiTenant: { required: false },
        autoIndex: shouldAutoIndex(),
        forceRecreate: process.env.NODE_ENV === 'test',

        // Better Auth stores organization._id as ObjectId — match the schema so
        // $lookup, .populate('organizationId'), and QueryParser `?lookup=organizationId`
        // work across the orders → organization boundary. Also drives the
        // multiTenantPlugin's auto-cast on the aggregation path.
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
        //
        // Blanket module — enables sales-side standing orders (B2B
        // distributor agreements where a customer commits to N units
        // across a cadence; each due cycle generates a fresh Order via
        // the line template). Powers the blanket-order resource.
        // RFQ module — purchase-side request-for-quote workflow.
        // Enables `engine.repositories.rfq` + `engine.models.Rfq` and the
        // `order:rfq.*` events. The `order:rfq.awarded` listener wired in
        // `inventory/rfq/events/award-bridge.ts` turns the winning quote
        // into a real PO via the procurement service.
        modules: { quotation: true, blanket: true, rfq: true },
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

      // Wire the order-FSM lifecycle handlers — the unified registry of
      // every side-effect that fires off an order status transition:
      //   - stock-commit       (order:fulfilled → DEFAULT → CUSTOMER move
      //                         + reservation release)
      //   - stock-return       (order:refunded post-shipped → reverse
      //                         move; ADJUSTMENT on defective disposition)
      //   - ledger-cogs-bridge (order:fulfilled → publish
      //                         accounting:order.fulfilled with orderId)
      //   - ledger-restock-bridge (order:refunded post-shipped non-defective
      //                         → publish accounting:return.restocked)
      // Each handler is a small async function with injected deps; tests
      // call `.handle(ctx, fakeDeps)` directly. See lifecycle/handler.ts.
      wireOrderLifecycleHandlers(engine);

      // Wire the order→POS-shift aggregation bridge. POS orders increment the
      // active shift's salesCount/salesTotal + per-method paymentBreakdown
      // atomically via $inc. See shift-aggregation.hook.ts.
      wireShiftAggregationHook(engine);

      // Wire the order→loyalty earn bridge. When confirmPayment flips
      // paymentState.chargeStatus to 'full' on an enrolled customer's order,
      // the hook calls engine.evaluateOrder which selects active EarningRule
      // records (managed at /dashboard/loyalty/earning-rules) and credits
      // points per matching rule. Per-rule idempotency on `${orderId}:${ruleId}`
      // keeps after:update re-fires from double-crediting. See
      // order-loyalty-hook.ts.
      wireOrderLoyaltyHook(engine);

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
