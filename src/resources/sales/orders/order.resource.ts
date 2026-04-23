/**
 * Order Resource — @classytic/order + Arc auto-CRUD.
 *
 * Arc auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
 * from the mongokit repository adapter.
 *
 * Custom routes ONLY for business logic the repo can't handle:
 * - POST /place — pipeline-driven order creation
 * - POST /:id/action — FSM-validated state transition
 * - PATCH /:id/payment-state — partial subdocument update
 */

import { defineResource } from '@classytic/arc';
import type { OrderContext } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { publish } from '#lib/events/arcEvents.js';
import { validateCodSettlementInputs } from '#resources/accounting/posting/contracts/cod-settlement.contract.js';
import { createAdapter } from '#shared/adapter.js';
import { getContextFromReq } from '#shared/context.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { getRevenueEngine, isRevenueReady } from '#shared/revenue/engine.js';
import { createCatalogBridge } from './bridges/catalog.bridge.js';
import { createFlowBridge } from './bridges/flow.bridge.js';
import { getEcomBranchId } from './ecom-branch.js';
import { ensureOrderEngine } from './order.engine.js';
import { type OrderLineInput, releaseOrderStock, resolveLineSkus } from './order-placement.js';
import { executePlacement } from './placement.service.js';
import { resolveCaptureTransactionId } from './resolve-capture-txn.js';

/**
 * Read the authenticated user's id from the Fastify request.
 *
 * MUST match what placement.service.ts stores as `order.actorRef`, which
 * comes from `getContextFromReq(req).actorRef = req.scope.userId` (see
 * [shared/context.ts]). Reading `req.user._id` directly would silently
 * diverge in any setup where the auth plugin's user shape differs from
 * Arc's scope.
 *
 * `/my` routes scope orders via `{ actorRef: userId, actorKind: 'user' }`.
 * Guest orders carry `actorKind: 'session'` and are excluded by the filter.
 */
function getAuthUserId(req: FastifyRequest): string | null {
  const scope = (req as unknown as { scope?: { userId?: string } }).scope;
  if (scope?.userId) return scope.userId;
  const user = (req as unknown as { user?: { _id?: string; id?: string } }).user;
  return user?._id || user?.id || null;
}

// The engine is initialized at module-load time via top-level await. This
// works because `createApplication` connects mongoose BEFORE calling
// `loadResources()`, and the vitest setup does the same in `beforeAll`.
// We therefore hand Arc a REAL `DataAdapter`, not a lazy proxy — which is
// what `BaseController.list/get` requires to read `.repository.getAll()`
// synchronously during a request.
const orderEngine = await ensureOrderEngine();
const orderAdapter = createAdapter(orderEngine.models.Order as never, orderEngine.repositories.order as never);

const orderResource = defineResource({
  name: 'order',
  displayName: 'Orders',
  tag: 'Orders',
  prefix: '/orders',
  audit: true,

  // Arc auto-CRUD from mongokit repository — list, get, create, update, delete.
  adapter: orderAdapter,

  queryParser,

  // Arc's `orgScoped` preset forwards `x-organization-id` into the repo call
  // options, which mongokit's multi-tenant plugin (auto-wired inside
  // `@classytic/order`) picks up for POLICY-priority filter injection.
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    create: permissions.orders.create,
    update: permissions.orders.update,
    delete: permissions.orders.delete,
  },

  // Custom routes — ONLY for business logic that Arc CRUD can't handle
  routes: [
    // POST /place — pipeline-driven create (not raw CRUD — builds complex doc shape)
    {
      method: 'POST',
      path: '/place',
      summary: 'Place a new order through the order pipeline',
      permissions: permissions.orders.create,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body as Record<string, unknown>;
        const reqCtx = getContextFromReq(req) as OrderContext;

        // Optional e-commerce scope pin — when a branch is flagged
        // `fulfillsEcommerce: true` (via the Branches admin UI), every
        // customer-facing order lands there regardless of the browser's
        // `x-organization-id`. Prevents a misconfigured FE from writing
        // web orders into a physical store's ledger.
        const ecomBranchId = await getEcomBranchId();
        const ctx: OrderContext = ecomBranchId ? { ...reqCtx, organizationId: ecomBranchId } : reqCtx;

        const result = await executePlacement({ body, ctx, logger: req.log });
        return reply.status(result.status).send(result.body);
      },
    },

    // POST /validate-stock — pre-checkout availability check (no side effects)
    //
    // Lets the FE call this on /checkout page load (or on quantity change)
    // to warn users about low/zero stock BEFORE they enter payment details.
    // Returns per-line availability; does NOT reserve, does NOT charge.
    {
      method: 'POST',
      path: '/validate-stock',
      summary: 'Dry-run stock check for a cart — returns per-line availability',
      permissions: permissions.orders.create,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = req.body as { lines?: OrderLineInput[] };
        const reqCtx = getContextFromReq(req) as OrderContext;
        const rawLines = body.lines ?? [];

        if (rawLines.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'lines is required and must be non-empty',
          });
        }

        // E-commerce customers don't know about branches — the storefront
        // never sends `x-organization-id`. Pin to the operator-configured
        // e-commerce fulfillment branch (the one flagged
        // `fulfillsEcommerce: true` in the Branches admin UI) the same way
        // `/orders/place` and `/guest-orders` do, so validate-stock and
        // place always read from the SAME inventory.
        const ecomBranchId = await getEcomBranchId();
        const ctx: OrderContext = ecomBranchId ? { ...reqCtx, organizationId: ecomBranchId } : reqCtx;

        // Resolve SKUs using the same catalog bridge the /place path uses.
        const catalogBridge = createCatalogBridge();
        const resolvedLines = await resolveLineSkus(rawLines, catalogBridge, ctx);
        if (!resolvedLines) {
          return reply.status(400).send({
            success: false,
            error: 'Failed to resolve one or more line SKUs',
          });
        }

        // Read availability per SKU via Flow (no reservation, no mutation).
        const { getFlowEngineOrNull } = await import('#resources/inventory/flow/flow-engine.js');
        const { buildFlowContext, DEFAULT_LOCATION } = await import('#resources/inventory/flow/context-helpers.js');
        const flow = getFlowEngineOrNull();
        if (!flow) {
          // Flow not wired — assume stock is always available (dev-only path).
          return reply.send({
            success: true,
            data: {
              ok: true,
              lines: resolvedLines.map((l) => ({ ...l, available: Infinity })),
            },
          });
        }

        const flowCtx = buildFlowContext(ctx.organizationId, ctx.actorRef);
        const perLine = await Promise.all(
          resolvedLines.map(async (line) => {
            try {
              const avail = await flow.services.quant.getAvailability(
                { skuRef: line.skuRef, locationId: DEFAULT_LOCATION },
                flowCtx,
              );
              const available = (avail.quantityOnHand ?? 0) - (avail.quantityReserved ?? 0);
              return {
                lineId: line.lineId,
                skuRef: line.skuRef,
                requested: line.quantity,
                available,
                ok: available >= line.quantity,
              };
            } catch {
              // No quant yet = no stock. Treat as zero available.
              return {
                lineId: line.lineId,
                skuRef: line.skuRef,
                requested: line.quantity,
                available: 0,
                ok: false,
              };
            }
          }),
        );

        const allOk = perLine.every((l) => l.ok);
        reply.send({ success: true, data: { ok: allOk, lines: perLine } });
      },
    },

    // GET /my — paginated order history for the authenticated customer
    //
    // Scopes by { actorRef, actorKind: 'user' } so only orders placed by
    // the authenticated user are returned. Forwards mongokit's `getAll`
    // envelope verbatim (docs/total/pages at top level) — same shape
    // Arc's BaseController.list returns for auto-CRUD.
    {
      method: 'GET',
      path: '/my',
      summary: 'List my orders (current customer, paginated)',
      permissions: permissions.orders.list,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { page?: string; limit?: string; status?: string; sort?: string };
        const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '10', 10) || 10));
        const sort = q.sort ?? '-createdAt';

        const userId = getAuthUserId(req);
        if (!userId) {
          return reply.send({
            success: true,
            method: 'offset',
            docs: [],
            page,
            limit,
            total: 0,
            pages: 0,
            hasNext: false,
            hasPrev: false,
          });
        }

        const filters: Record<string, unknown> = { actorRef: userId, actorKind: 'user' };
        if (q.status) filters.status = q.status;

        const engine = await ensureOrderEngine();
        const repo = engine.repositories.order as unknown as {
          getAll: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
        const result = await repo.getAll({ filters, page, limit, sort });

        reply.send({ success: true, ...result });
      },
    },

    // GET /my/:id — single order detail, scoped to the authenticated customer.
    // 404 if the order exists but belongs to another customer — never leak
    // cross-customer order data.
    {
      method: 'GET',
      path: '/my/:id',
      summary: 'Get my order by id (or orderNumber)',
      permissions: permissions.orders.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const userId = getAuthUserId(req);
        if (!userId) {
          return reply.status(404).send({ success: false, error: 'Order not found' });
        }

        // Only include the `_id` clause when `id` looks like a valid
        // ObjectId — passing an `orderNumber` (e.g. "ORD-2026-0001")
        // through a raw $or on `_id` crashes with a cast error before
        // the orderNumber match gets a chance to run.
        const isObjectId = /^[a-f0-9]{24}$/i.test(id);
        const idClauses: Record<string, unknown>[] = [{ orderNumber: id }];
        if (isObjectId) idClauses.push({ _id: id });

        const engine = await ensureOrderEngine();
        const repo = engine.repositories.order as unknown as {
          getByQuery: (
            f: Record<string, unknown>,
            o?: Record<string, unknown>,
          ) => Promise<unknown | null>;
        };
        const order = await repo.getByQuery(
          {
            actorRef: userId,
            actorKind: 'user',
            $or: idClauses,
          },
          { throwOnNotFound: false },
        );

        if (!order) {
          return reply.status(404).send({ success: false, error: 'Order not found' });
        }
        reply.send({ success: true, data: order });
      },
    },

    // GET /:orderNumber/events — append-only OrderEvent log for an order.
    //
    // Timeline UI reads this to show "confirmed at X by Y", "fulfillment
    // shipped at Z" etc. The events collection is populated by
    // @classytic/order's OrderEventSink when domain verbs fire (transition,
    // cancel, createForOrder, addTracking, ...). Read-only here — events
    // are append-only by schema.
    {
      method: 'GET',
      path: '/:orderNumber/events',
      summary: 'List timeline events for an order (append-only)',
      permissions: permissions.orders.get,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { orderNumber } = req.params as { orderNumber: string };
        const q = req.query as { page?: string; limit?: string };
        const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));

        const engine = await ensureOrderEngine();
        const repo = engine.repositories.orderEvent as unknown as {
          getAll: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
        const result = await repo.getAll({
          filters: { orderNumber },
          sort: 'createdAt',
          page,
          limit,
        });

        reply.send({ success: true, ...result });
      },
    },

    // POST /:id/action — FSM transition (Stripe action pattern)
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Order action (confirm, cancel, hold, release, refund)',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const body = req.body as { action: string; reason?: string };
        const ctx = getContextFromReq(req) as OrderContext;
        // be-prod runs @classytic/order with `multiTenant: false` — the repo
        // methods don't auto-filter by organizationId, so custom routes like
        // this (which bypass Arc's CRUD scoping preset) MUST enforce it here.
        // Without this check, a branch A admin could transition a branch B
        // order by guessing the orderNumber.
        const scoped = await engine.repositories.order.getByQuery(
          { orderNumber: id, organizationId: ctx.organizationId },
          { throwOnNotFound: false },
        );
        if (!scoped) {
          return reply.status(404).send({ success: false, error: 'Order not found' });
        }

        const statusMap: Record<string, string> = {
          confirm: 'confirmed',
          process: 'processing',
          fulfill: 'fulfilled',
          complete: 'completed',
          cancel: 'canceled',
          refund: 'refunded',
          hold: 'on_hold',
          release_hold: 'confirmed',
          approve_fraud: 'confirmed',
        };
        const order = await engine.repositories.order.transition(id, statusMap[body.action] ?? body.action, ctx, {
          reason: body.reason,
        });

        // On cancel/refund, release any stock reservations back to the pool.
        // Idempotent — safe if reservations were already consumed by shipment
        // or released by TTL sweep.
        if (body.action === 'cancel' || body.action === 'refund') {
          const meta = (
            order as {
              metadata?: {
                reservationRefs?: Array<{ lineId: string; reservationId: string; skuRef: string; quantity: number }>;
                codSettlement?: { actualReceived: number; courierCommission: number; writeoff: number };
              };
              payment?: { gateway?: string; method?: string };
              totals?: { grandTotal?: { amount: number; currency: string }; tax?: { amount: number } };
            }
          ).metadata;
          const refs = meta?.reservationRefs ?? [];
          if (refs.length > 0) {
            const flowBridge = createFlowBridge();
            await releaseOrderStock(refs, flowBridge, ctx, req.log);
          }

          // COD reversal — if this was a COD order whose placement journal
          // already posted (A/R on 1141), publish the cancellation event so
          // the accounting handler posts the contra entry. Orders settled
          // via /cod-settlement are NOT reversed — the money is already in
          // the bank; use /refund for those.
          //
          // Source of truth for gateway is `metadata.paymentGateway`,
          // stamped at placement (see placement.service.ts). The order
          // package doesn't persist the raw `payment` block.
          const gateway = String(
            (meta as Record<string, unknown> | undefined)?.paymentGateway ?? '',
          ).toLowerCase();
          const alreadySettled = !!meta?.codSettlement;
          if (gateway === 'cod' && !alreadySettled) {
            const totals = (order as { totals?: { grandTotal?: { amount: number }; tax?: { amount: number } } })
              .totals;
            const grossAmount = totals?.grandTotal?.amount ?? 0;
            const tax = totals?.tax?.amount ?? 0;
            const promoDiscount = Number(
              (meta as Record<string, unknown> | undefined)?.promoTotalDiscount ?? 0,
            );
            if (grossAmount > 0) {
              await publish('accounting:cod.cancelled', {
                orderId: String((order as { _id: unknown })._id),
                grossAmount,
                tax,
                promoDiscount,
                reason: body.reason,
                date: new Date().toISOString(),
                branchId: ctx.organizationId,
              });
            }
          }
        }

        reply.send({ success: true, data: order });
      },
    },

    // PATCH /:id/payment-state — partial subdocument update (host calls after revenue events)
    {
      method: 'PATCH',
      path: '/:id/payment-state',
      summary: 'Update order payment state',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const order = await engine.repositories.order.updatePaymentState(
          id,
          req.body as Record<string, unknown>,
          getContextFromReq(req),
        );
        reply.send({ success: true, data: order });
      },
    },

    // POST /:id/cod-settlement — admin records the actual amount received
    // from a courier after they collect the COD amount and deduct their
    // commission. Emits `accounting:cod.settled` which clears the order's
    // A/R on 1141 and books the bank receipt + commission + any writeoff.
    //
    // Balance invariant (enforced):
    //   actualReceived + courierCommission + writeoff === grossAmount
    {
      method: 'POST',
      path: '/:id/cod-settlement',
      summary: 'Record COD settlement — reconcile gross A/R to actual bank receipt after courier deduction',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const body = req.body as {
          actualReceived: number;
          courierCommission: number;
          writeoff?: number;
          cashAccount?: '1111' | '1112';
          notes?: string;
          date?: string;
        };
        const ctx = getContextFromReq(req) as OrderContext;

        // Branch-scope check — same pattern as /:id/action above.
        const order = (await engine.repositories.order.getByQuery(
          { orderNumber: id, organizationId: ctx.organizationId },
          { throwOnNotFound: false },
        )) as {
          _id: { toString(): string };
          payment?: { gateway?: string; method?: string };
          totals?: { grandTotal?: { amount: number; currency: string } };
          metadata?: Record<string, unknown>;
          status?: string;
        } | null;
        if (!order) {
          return reply.status(404).send({ success: false, error: 'Order not found' });
        }

        // Source of truth for gateway is `metadata.paymentGateway`
        // (stamped by placement.service.ts). The order package doesn't
        // persist a raw `payment` block on the doc.
        const gateway = String(
          (order.metadata as Record<string, unknown> | undefined)?.paymentGateway ?? '',
        ).toLowerCase();
        if (gateway !== 'cod') {
          return reply.status(400).send({
            success: false,
            error: 'COD settlement is only valid for cash-on-delivery orders',
          });
        }

        // Guard against double-settlement. If the caller needs to adjust
        // a prior settlement, they should cancel the order or open a
        // separate correcting journal entry — never silently overwrite.
        if (order.metadata?.codSettlement) {
          return reply.status(409).send({
            success: false,
            error: 'COD settlement already recorded for this order',
            code: 'ALREADY_SETTLED',
          });
        }

        const grossAmount = order.totals?.grandTotal?.amount ?? 0;
        if (grossAmount <= 0) {
          return reply.status(400).send({
            success: false,
            error: 'Order has no gross amount to settle',
          });
        }

        const actualReceived = Math.max(0, Math.trunc(Number(body.actualReceived) || 0));
        const courierCommission = Math.max(0, Math.trunc(Number(body.courierCommission) || 0));
        const writeoff = Math.max(0, Math.trunc(Number(body.writeoff) || 0));

        const check = validateCodSettlementInputs({
          grossAmount,
          actualReceived,
          courierCommission,
          writeoff,
        });
        if (!check.ok) {
          return reply.status(400).send({ success: false, error: check.reason, code: 'SETTLEMENT_UNBALANCED' });
        }

        const settlementId = `cod-settle-${String(order._id)}-${Date.now()}`;
        const settledAt = body.date ? new Date(body.date) : new Date();

        // Persist settlement details on the order metadata so the admin UI
        // can display what was recorded and /action's cancel path can tell
        // whether the order is already settled (don't reverse settled COD;
        // use /refund instead).
        const settlementRecord = {
          settlementId,
          actualReceived,
          courierCommission,
          writeoff,
          cashAccount: body.cashAccount ?? '1112',
          notes: body.notes,
          settledAt,
          settledBy: ctx.actorRef,
        };
        // Dot-notation $set via raw Model — same pattern as updatePaymentState.
        // repo.update() would double-wrap in $set. Bypassing mongokit's hooks
        // here is intentional: the event we publish below IS the side effect.
        const orderModel = engine.models.Order;
        await orderModel.updateOne(
          { _id: order._id },
          { $set: { 'metadata.codSettlement': settlementRecord } },
        );

        await publish('accounting:cod.settled', {
          settlementId,
          orderId: String(order._id),
          grossAmount,
          actualReceived,
          courierCommission,
          writeoff,
          cashAccount: settlementRecord.cashAccount,
          notes: body.notes,
          date: settledAt.toISOString(),
          branchId: ctx.organizationId,
        });

        reply.send({ success: true, data: settlementRecord });
      },
    },

    // POST /:id/refund — admin-initiated refund on a prepaid/COD order
    //
    // Unlike `/action { action: 'refund' }` (which only releases stock + FSM
    // transitions), this endpoint actually issues the payment refund:
    //
    //   - Prepaid (bKash/card/bank): calls revenue.transaction.refund() which
    //     fires the revenue plugin's after:update hook → publishes
    //     `accounting:transaction.refunded` → refundToPosting contract →
    //     ledger entry (Dr 4111 Revenue + Dr 2132 VAT | Cr 1112 Bank).
    //
    //   - COD unsettled: emits `accounting:cod.cancelled` (the A/R hasn't
    //     been collected yet, so we just reverse the placement journal).
    //
    //   - COD settled: rejects with COD_SETTLED_USE_RMA — the money is
    //     already in the bank and returning it requires the full RMA flow
    //     (stock restoration + the right order of journal entries). This
    //     endpoint is the "quick refund" path, not the "process a return"
    //     path. Use /sales/returns for that.
    //
    // Idempotency: guarded by `metadata.refundedAt`. Re-calling returns 409
    // ALREADY_REFUNDED so double-clicks never double-refund.
    //
    // Partial refunds are supported — pass `amount` (paisa) less than the
    // order total. The order status stays unchanged for partials (no
    // 'partially_refunded' FSM state on the kernel today); metadata
    // records the amount so the UI can show it. Full refund transitions
    // the order to 'refunded'.
    {
      method: 'POST',
      path: '/:id/refund',
      summary: 'Refund a prepaid order (or COD unsettled) — issues payment refund and posts reversal journal',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { amount?: number; reason?: string; restockItems?: boolean };
        const ctx = getContextFromReq(req) as OrderContext;

        const order = (await engine.repositories.order.getByQuery(
          { orderNumber: id, organizationId: ctx.organizationId },
          { throwOnNotFound: false },
        )) as {
          _id: { toString(): string };
          orderNumber?: string;
          status?: string;
          totals?: { grandTotal?: { amount: number; currency?: string }; tax?: { amount: number } };
          metadata?: Record<string, unknown>;
          currentPayment?: { transactionId?: unknown } | null;
          // Matches `@classytic/order`'s canonical schema (`PaymentState` VO)
          // — the original `transactions` alias was a drift that bypassed
          // `resolveCaptureTransactionId`'s type check.
          paymentState?: { transactionRefs?: Array<{ type?: string; status?: string; transactionId?: string }> };
        } | null;
        if (!order) {
          return reply.status(404).send({ success: false, error: 'Order not found' });
        }

        const meta = (order.metadata as Record<string, unknown> | undefined) ?? {};
        const gateway = String(meta.paymentGateway ?? '').toLowerCase();
        const isCod = gateway === 'cod';
        const codSettled = !!meta.codSettlement;

        if (meta.refundedAt) {
          return reply.status(409).send({
            success: false,
            error: 'Order is already refunded',
            code: 'ALREADY_REFUNDED',
          });
        }

        // COD already settled: money is in the bank, reversing it requires
        // the full RMA flow (stock restoration + cash out). Reject so nobody
        // posts an A/R contra that doesn't match reality.
        if (isCod && codSettled) {
          return reply.status(400).send({
            success: false,
            error: 'COD order is already settled — use the RMA flow (POST /sales/returns) for a refund',
            code: 'COD_SETTLED_USE_RMA',
          });
        }

        const grossAmount = order.totals?.grandTotal?.amount ?? 0;
        if (grossAmount <= 0) {
          return reply.status(400).send({ success: false, error: 'Order has no amount to refund' });
        }

        const amount = Math.max(0, Math.trunc(Number(body.amount ?? grossAmount)));
        if (amount <= 0) {
          return reply.status(400).send({ success: false, error: 'amount must be positive' });
        }
        if (amount > grossAmount) {
          return reply.status(400).send({
            success: false,
            error: `amount (${amount}) exceeds order total (${grossAmount})`,
            code: 'AMOUNT_EXCEEDS_TOTAL',
          });
        }

        const reason = body.reason?.trim() || `Admin refund for order ${order.orderNumber ?? String(order._id)}`;

        // Prepaid: delegate to revenue. The revenue plugin's after:update
        // hook on the created refund txn publishes accounting:transaction.refunded
        // which the accounting handler turns into a reversal journal entry.
        if (!isCod) {
          const txnId = resolveCaptureTransactionId(order);
          if (!txnId) {
            return reply.status(400).send({
              success: false,
              error: 'No verified capture transaction found — cannot refund',
              code: 'NO_CAPTURE_TXN',
            });
          }
          if (!isRevenueReady()) {
            return reply.status(503).send({ success: false, error: 'Revenue engine unavailable' });
          }
          try {
            await getRevenueEngine().repositories.transaction.refund(txnId, amount, { reason });
          } catch (err) {
            req.log.error(
              { err: (err as Error).message, orderId: id, txnId },
              'Revenue refund failed',
            );
            return reply.status(500).send({
              success: false,
              error: 'Revenue refund failed',
              details: (err as Error).message,
            });
          }
        } else {
          // COD unsettled — emit the existing cancellation-reversal event.
          // Uses `amount` (not grossAmount) so partial refunds post the
          // proportional contra; VAT scales linearly on the BD rate we
          // charged at placement.
          const tax = order.totals?.tax?.amount ?? 0;
          const proportionalTax = grossAmount > 0 ? Math.round((tax * amount) / grossAmount) : 0;
          const promoDiscount = Number(meta.promoTotalDiscount ?? 0);
          const proportionalPromo =
            grossAmount > 0 ? Math.round((promoDiscount * amount) / grossAmount) : 0;

          await publish('accounting:cod.cancelled', {
            orderId: String(order._id),
            grossAmount: amount,
            tax: proportionalTax,
            promoDiscount: proportionalPromo,
            reason,
            date: new Date().toISOString(),
            branchId: ctx.organizationId,
          });
        }

        // Stamp refund record on metadata. Bypass the FSM for the metadata
        // stamp (same pattern as /cod-settlement) — the event we just
        // published IS the canonical side effect; this is bookkeeping.
        const isFullRefund = amount === grossAmount;
        const refundRecord = {
          amount,
          reason,
          refundedAt: new Date(),
          refundedBy: ctx.actorRef,
          isPartial: !isFullRefund,
        };
        const orderModel = engine.models.Order;
        await orderModel.updateOne(
          { _id: order._id },
          {
            $set: {
              'metadata.refundedAt': refundRecord.refundedAt,
              'metadata.refundedAmount': amount,
              'metadata.refundReason': reason,
              'metadata.refundIsPartial': !isFullRefund,
            },
          },
        );

        // Full refund transitions status via the FSM so any order-side
        // hooks (timeline, notifications) fire. Partial refunds leave
        // status alone — there's no 'partially_refunded' state on the
        // kernel today, and multiple partials shouldn't each transition.
        if (isFullRefund) {
          try {
            await engine.repositories.order.transition(id, 'refunded', ctx, { reason });
          } catch (err) {
            // Non-fatal: the refund already went through; the status just
            // didn't transition (e.g. order was already in terminal state).
            req.log.warn(
              { err: (err as Error).message, orderId: id },
              'Order status transition to refunded failed (refund itself succeeded)',
            );
          }
        }

        // Optional: release stock reservations back to the pool. Not the
        // default — a refund doesn't necessarily mean we got the product
        // back (that's RMA's job). Caller opts in.
        if (body.restockItems) {
          const refs = (meta as { reservationRefs?: Array<{ lineId: string; reservationId: string; skuRef: string; quantity: number }> })
            .reservationRefs ?? [];
          if (refs.length > 0) {
            const flowBridge = createFlowBridge();
            await releaseOrderStock(refs, flowBridge, ctx, req.log);
          }
        }

        // Tenant-scope already enforced by the getByQuery above; just
        // fetch the fresh doc so the response reflects the FSM + metadata
        // updates we just made.
        const refreshed = await engine.repositories.order.getById(String(order._id));
        reply.send({ success: true, data: refreshed, refund: refundRecord });
      },
    },
  ],
});

export default orderResource;
