/**
 * Customer-facing RMA + fulfillment-visibility handlers.
 *
 * Scope: a logged-in customer reading their own order's fulfillments,
 * change history, or initiating a return / exchange / claim.
 *
 * All handlers gate on `actorRef === userId AND actorKind === 'user'`
 * — same scoping as `my-orders.handler.ts`. The kernel's tenant-aware
 * `engine.repositories.*` does the org-scoped filtering automatically
 * via `getEcomPinnedContext` (single-tenant ecom branch resolution).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  OrderChangeActionType,
  type OrderContext,
  repoOptionsFromCtx,
} from '@classytic/order';
import { type Disposition, VALID_DISPOSITIONS } from '../lifecycle/handlers/_shared.js';
import { ensureOrderEngine } from '../order.engine.js';
import {
  getAuthUserId,
  getEcomPinnedContext,
  getOrderContext,
  type OrderRepository,
} from './shared.js';
import { createError, NotFoundError, ValidationError } from '@classytic/arc/utils';

/**
 * Look up an order owned by the current customer. Accepts orderNumber OR
 * raw _id. Returns null if not found / not theirs.
 */
async function findOwnOrder(
  id: string,
  userId: string,
  ctx: OrderContext,
): Promise<Record<string, unknown> | null> {
  const isObjectId = /^[a-f0-9]{24}$/i.test(id);
  const idClauses: Record<string, unknown>[] = [{ orderNumber: id }];
  if (isObjectId) idClauses.push({ _id: id });
  const engine = await ensureOrderEngine();
  const repo = engine.repositories.order as unknown as OrderRepository;
  const order = await repo.getByQuery(
    { actorRef: userId, actorKind: 'user', $or: idClauses },
    { ...ctx, throwOnNotFound: false },
  );
  return (order ?? null) as Record<string, unknown> | null;
}

/** GET /orders/my/:id/fulfillments — customer can see tracking + delivery status. */
export async function listMyOrderFulfillmentsHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const userId = getAuthUserId(req);
  if (!userId) throw new NotFoundError('Order');
  const ctx = await getEcomPinnedContext(req);
  const order = await findOwnOrder(id, userId, ctx);
  if (!order) throw new NotFoundError('Order');

  const engine = await ensureOrderEngine();
  // Fulfillments are tenant-scoped on the same engine context. We filter
  // by orderId so a leaked orderNumber from another tenant still can't
  // pull cross-tenant fulfillments.
  const fulfillments = await engine.repositories.fulfillment.getAll({
    filters: { orderId: order._id },
    sort: '-createdAt',
    limit: 100,
    ...repoOptionsFromCtx(ctx),
  } as Record<string, unknown>);

  const fulfillmentList = (fulfillments as { data?: unknown[] }).data ?? fulfillments;
  return reply.send({ data: fulfillmentList });
}

/** GET /orders/my/:id/changes — list customer's RMA history for one order. */
export async function listMyOrderChangesHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const userId = getAuthUserId(req);
  if (!userId) throw new NotFoundError('Order');
  const ctx = await getEcomPinnedContext(req);
  const order = await findOwnOrder(id, userId, ctx);
  if (!order) throw new NotFoundError('Order');

  const engine = await ensureOrderEngine();
  const changes = await engine.repositories.orderChange.getAll({
    filters: { orderId: order._id },
    sort: '-createdAt',
    limit: 50,
    ...repoOptionsFromCtx(ctx),
  } as Record<string, unknown>);

  const changeList = (changes as { data?: unknown[] }).data ?? changes;
  return reply.send({ data: changeList });
}

/**
 * POST /orders/my/:id/changes — customer-initiated return / exchange / claim.
 *
 * Body shape:
 *   {
 *     changeType: 'return' | 'exchange' | 'claim',
 *     lines:      [{ orderLineId, quantity, reason? }, ...],
 *     reason?:    string,
 *     // exchange-specific:
 *     replacementSku?: string,
 *     // claim-specific:
 *     claimEvidence?: [{ type, url, description? }, ...],
 *   }
 *
 * The kernel's `requestChange` validates that each `orderLineId` is real and
 * that `quantity ≤ fulfilled - alreadyReturned` (no over-returning).
 * `replacementSku` (exchange) and `claimEvidence` (claim) are passed via
 * `internalNote` as a JSON-serialised payload — the kernel persists it as
 * a free-form string so no shape contract leaks.
 */
export async function createMyOrderChangeHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const userId = getAuthUserId(req);
  if (!userId) throw new NotFoundError('Order');

  const body = req.body as {
    changeType?: 'return' | 'exchange' | 'claim';
    lines?: Array<{ orderLineId: string; quantity: number; reason?: string }>;
    reason?: string;
    replacementSku?: string;
    claimEvidence?: Array<{ type: string; url: string; description?: string }>;
  };

  if (!body?.changeType || !['return', 'exchange', 'claim'].includes(body.changeType)) {
    throw new ValidationError('changeType must be one of: return, exchange, claim');
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    throw new ValidationError('lines[] must contain at least one entry');
  }

  const ctx = await getEcomPinnedContext(req);
  const order = await findOwnOrder(id, userId, ctx);
  if (!order) throw new NotFoundError('Order');

  const engine = await ensureOrderEngine();
  // ctx.actorKind is `user` for authenticated customer requests, so the
  // kernel will auto-stamp `metadata.initiatedBy = 'customer'`.
  try {
    const orderNumber = String(order.orderNumber);
    const actions = body.lines.map((l) => ({
      type: OrderChangeActionType.RETURN_ITEM,
      orderLineId: l.orderLineId,
      quantity: l.quantity,
      reason: l.reason,
    }));
    const noteParts: Record<string, unknown> = {};
    if (body.changeType === 'exchange' && body.replacementSku) {
      noteParts.replacementSku = body.replacementSku;
    }
    if (body.changeType === 'claim' && body.claimEvidence) {
      noteParts.claimEvidence = body.claimEvidence;
    }
    const change = await engine.repositories.orderChange.requestChange(
      {
        orderNumber,
        changeType: body.changeType,
        actions,
        reason: body.reason,
        internalNote: Object.keys(noteParts).length > 0 ? JSON.stringify(noteParts) : undefined,
      },
      ctx,
    );
    return reply.status(201).send(change);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create change request';
    // Kernel validation errors are user-input errors; surface with 422 so
    // the FE can show the exact reason ("exceeds returnable 1", etc.).
    const isValidation =
      /unknown orderLineId|exceeds returnable|must be > 0|Order not found/i.test(message);
    if (isValidation) throw new ValidationError(message);
    throw createError(500, message);
  }
}

/**
 * POST /orders/:id/changes — admin-initiated return / exchange / claim.
 *
 * Mirrors the customer surface (`/orders/my/:id/changes`) but skips the
 * `actorRef === userId` ownership check. Use cases:
 *   • CSR opens an OrderChange on behalf of a customer who phoned in.
 *   • E2E / integration tests that don't seed orders against an auth user.
 *
 * Same kernel call (`requestChange`), same body shape, same validation
 * surface — only the order-lookup step changes (admin can target any order
 * inside the active org, not just their own).
 */
/**
 * Admin RMA payload — `Disposition` lets the warehouse and ledger handlers
 * route per-line at confirm-time without needing a separate inspect step.
 *
 *   restock              → goods are sellable, return to DEFAULT location,
 *                          COGS reversal posted (Dr Inventory / Cr COGS).
 *   damaged | defective  → goods are unsellable but distinguishable from
 *   | scrap | write_off    pure shrinkage; route to ADJUSTMENT location and
 *                          post inventory-loss JE (Dr Shrinkage / Cr Inventory).
 *                          COGS is NOT reversed — the original COGS expense
 *                          stands (we sold a unit that's now scrap).
 *
 * Either pass per-line via `lines[].disposition` (overrides everything),
 * or pass change-level via `disposition` (applied uniformly to every line).
 * Omit both → legacy reason-regex fallback ("damaged" / "defect" / etc. in
 * `reason` triggers write-off; otherwise restock).
 */

export async function adminCreateOrderChangeHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };

  const body = req.body as {
    changeType?: 'return' | 'exchange' | 'claim';
    lines?: Array<{ orderLineId: string; quantity: number; reason?: string; disposition?: Disposition }>;
    reason?: string;
    /** Change-level disposition applied to every line that doesn't override. */
    disposition?: Disposition;
    /**
     * Merchant-retained handling fee in paisa, recognised on confirm as
     * Other Income (4319). Customer's effective refund is the goods value
     * minus this fee. Optional — no fee = no JE posted.
     */
    restockingFee?: number;
    /**
     * QC inspection mode (Odoo-style). When `true`, on confirm goods land
     * in RETURN_HOLDING and ledger is DEFERRED until a separate `inspect`
     * action finalizes per-line disposition. Default `false` — confirm
     * does goods + ledger in one step (current behavior).
     */
    requireInspection?: boolean;
    replacementSku?: string;
    claimEvidence?: Array<{ type: string; url: string; description?: string }>;
  };

  if (!body?.changeType || !['return', 'exchange', 'claim'].includes(body.changeType)) {
    throw new ValidationError('changeType must be one of: return, exchange, claim');
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    throw new ValidationError('lines[] must contain at least one entry');
  }
  if (body.disposition && !VALID_DISPOSITIONS.has(body.disposition)) {
    throw new ValidationError(`disposition must be one of: ${[...VALID_DISPOSITIONS].join(', ')}`);
  }
  for (const l of body.lines) {
    if (l.disposition && !VALID_DISPOSITIONS.has(l.disposition)) {
      throw new ValidationError(`lines[].disposition must be one of: ${[...VALID_DISPOSITIONS].join(', ')}`);
    }
  }
  if (body.restockingFee !== undefined) {
    if (typeof body.restockingFee !== 'number' || body.restockingFee < 0 || !Number.isFinite(body.restockingFee)) {
      throw new ValidationError('restockingFee must be a non-negative finite number (paisa)');
    }
  }

  const ctx = getOrderContext(req);
  const engine = await ensureOrderEngine();

  // Resolve order by orderNumber OR raw _id, scoped to the active org.
  const isObjectId = /^[a-f0-9]{24}$/i.test(id);
  const idClauses: Record<string, unknown>[] = [{ orderNumber: id }];
  if (isObjectId) idClauses.push({ _id: id });
  const order = (await (engine.repositories.order as unknown as OrderRepository).getByQuery(
    { $or: idClauses, organizationId: ctx.organizationId },
    { throwOnNotFound: false },
  )) as Record<string, unknown> | null;
  if (!order) {
    throw new NotFoundError('Order');
  }

  try {
    const orderNumber = String(order.orderNumber);
    const actions = body.lines.map((l) => ({
      type: OrderChangeActionType.RETURN_ITEM,
      orderLineId: l.orderLineId,
      quantity: l.quantity,
      reason: l.reason,
    }));
    const noteParts: Record<string, unknown> = {};
    if (body.changeType === 'exchange' && body.replacementSku) {
      noteParts.replacementSku = body.replacementSku;
    }
    if (body.changeType === 'claim' && body.claimEvidence) {
      noteParts.claimEvidence = body.claimEvidence;
    }
    const change = await engine.repositories.orderChange.requestChange(
      {
        orderNumber,
        changeType: body.changeType,
        actions,
        reason: body.reason,
        internalNote: Object.keys(noteParts).length > 0 ? JSON.stringify(noteParts) : undefined,
      },
      ctx,
    );

    // Post-create stamp: the kernel's `requestChange` doesn't accept a
    // `metadata` block, so we $set after creation. This is read by the
    // change-confirmed-stock-return + change-confirmed-ledger-restock-bridge
    // handlers at confirm time.
    //
    // Per-line dispositions are stored as an ORDERED ARRAY aligned with
    // `actions[]` (the kernel auto-assigns actionId `act_${i}` matching this
    // order). Keyed by index — NOT by orderLineId — so one RMA can split a
    // single line into multiple actions with different dispositions
    // (e.g. order qty 5: return 3 sellable + 2 damaged in one ticket).
    //
    // Resolution priority in handlers: `dispositions[i]` > `disposition` >
    // reason-regex fallback.
    const update: Record<string, unknown> = {};
    if (body.disposition) update['metadata.disposition'] = body.disposition;
    const perLineArray: (Disposition | null)[] = body.lines.map((l) => l.disposition ?? null);
    if (perLineArray.some((d) => d !== null)) {
      update['metadata.dispositions'] = perLineArray;
    }
    // Restocking fee lands on `paymentDelta.restockingFee` so the lifecycle
    // handler reads it from the canonical kernel field. Kernel `requestChange`
    // initialises that field to zero — we $set after creation.
    if (body.restockingFee && body.restockingFee > 0) {
      const orderCurrency =
        (order as { currency?: string }).currency
        ?? ((order as { totals?: { grandTotal?: { currency?: string } } }).totals?.grandTotal?.currency)
        ?? 'BDT';
      update['paymentDelta.restockingFee'] = {
        amount: Math.round(body.restockingFee),
        currency: orderCurrency,
      };
    }
    if (body.requireInspection === true) {
      update['metadata.requireInspection'] = true;
    }
    if (Object.keys(update).length > 0) {
      await engine.models.OrderChange.updateOne(
        { changeNumber: (change as { changeNumber: string }).changeNumber },
        { $set: update },
      );
    }

    return reply.status(201).send(change);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create change request';
    const isValidation =
      /unknown orderLineId|exceeds returnable|must be > 0|Order not found/i.test(message);
    if (isValidation) throw new ValidationError(message);
    throw createError(500, message);
  }
}
