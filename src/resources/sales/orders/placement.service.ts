/**
 * Shared order placement pipeline.
 *
 * Used by both:
 *   - POST /orders/place       (staff + logged-in customer)
 *   - POST /orders/guest/place (anonymous guest, gated by GUEST_CHECKOUT)
 *
 * Keeping a single implementation means promo commit, stock reservation,
 * idempotency, and payment attach behave identically across channels —
 * only the caller (and the body shape it trusts) differs.
 *
 * Returns a `{ status, body }` envelope instead of writing to a Fastify
 * reply so the two routes can set their own headers (guest tokens etc.)
 * without coupling the pipeline to the HTTP layer.
 */

import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import {
  buildPromoLines,
  commitPromo,
  computePromoSubtotal,
  reservePromo,
  rollbackPromo,
} from '#resources/promotions/promo-placement.js';
import { isRevenueReady } from '#shared/revenue/engine.js';
import { createCatalogBridge } from './bridges/catalog.bridge.js';
import { createFlowBridge } from './bridges/flow.bridge.js';
import { createRevenueBridge } from './bridges/revenue.bridge.js';
import type { OrderChannel } from './channel.js';
import { ensureOrderEngine } from './order.engine.js';
import { attachPaymentToOrder, type OrderPaymentInput } from './order-payment.js';
import {
  buildOrderLinesWithSnapshots,
  extractStockShortage,
  isInsufficientStockError,
  type OrderLineInput,
  releaseOrderStock,
  reserveOrderStock,
  resolveLineSkus,
} from './order-placement.js';
import { toFulfillmentAddress } from './shipping-address.js';

export interface PlacementInput {
  body: Record<string, unknown>;
  ctx: OrderContext;
  logger: FastifyBaseLogger;
  /** Force channel regardless of body.channel — guest route pins to 'web'. */
  forceChannel?: OrderChannel;
}

export interface PlacementResult {
  status: number;
  body: Record<string, unknown>;
}

export async function executePlacement(input: PlacementInput): Promise<PlacementResult> {
  const { body, ctx, logger, forceChannel } = input;
  const engine = await ensureOrderEngine();

  const rawLines = (body.lines as OrderLineInput[] | undefined) ?? [];
  if (rawLines.length === 0) {
    return { status: 400, body: { success: false, error: 'Order must contain at least one line' } };
  }

  // Idempotency short-circuit
  const idempotencyKey = (body.idempotencyKey as string | undefined) ?? undefined;
  if (idempotencyKey) {
    const existing = await engine.models.Order.findOne({
      organizationId: ctx.organizationId,
      'metadata.idempotencyKey': idempotencyKey,
    }).lean();
    if (existing) {
      return { status: 201, body: { success: true, data: existing, idempotent: true } };
    }
  }

  // Resolve SKUs so we can reserve stock
  const catalogBridge = createCatalogBridge();
  const resolvedLines = await resolveLineSkus(rawLines, catalogBridge, ctx);
  if (!resolvedLines) {
    return { status: 400, body: { success: false, error: 'Failed to resolve one or more line SKUs' } };
  }

  // Atomic reservation (protects against oversell)
  const flowBridge = createFlowBridge();
  let reservation: Awaited<ReturnType<typeof reserveOrderStock>>;
  try {
    reservation = await reserveOrderStock(resolvedLines, flowBridge, ctx, logger);
  } catch (err) {
    if (isInsufficientStockError(err)) {
      return {
        status: 409,
        body: {
          success: false,
          error: 'Insufficient stock for one or more items',
          code: 'INSUFFICIENT_STOCK',
          message: (err as Error).message,
          details: extractStockShortage(err),
        },
      };
    }
    throw err;
  }

  // Server-authoritative promo application. Client submits `promoCodes`
  // only; the engine evaluates against the canonical `resolvedLines` we
  // just reserved stock for — not against anything the client claims
  // about cart contents. This makes cart-hash tamper impossible by
  // construction: same inputs go into evaluate + commit, one process, one
  // memory region. See `promo-placement.ts` for the full contract.
  const promoCodes = body.promoCodes as string[] | undefined;
  const promoLines = buildPromoLines(resolvedLines);
  const promoSubtotal = computePromoSubtotal(promoLines);
  const customerRef = body.customer as { _id?: string; email?: string } | undefined;

  const promoReservation = await reservePromo({
    codes: promoCodes,
    lines: promoLines,
    subtotal: promoSubtotal,
    customerId: customerRef?._id,
    actorId: ctx.actorRef,
    organizationId: ctx.organizationId as string | undefined,
    logger,
  });

  const linesWithSnapshots = buildOrderLinesWithSnapshots(rawLines, resolvedLines);

  // Stamp the gateway into metadata so downstream handlers (accounting
  // event handler, cancel reversal, COD settlement endpoint) can detect
  // COD orders without re-querying the revenue transaction. The order
  // package's schema doesn't persist the raw `payment` input block, only
  // `paymentState` — `metadata.paymentGateway` is our handle.
  const paymentBlock = body.payment as { gateway?: string; method?: string } | undefined;
  const paymentGateway = (paymentBlock?.gateway ?? paymentBlock?.method ?? '').toString().toLowerCase();

  let order: Record<string, unknown>;
  try {
    order = (await engine.repositories.order.create(
      {
        channel: (forceChannel ?? (body.channel as OrderChannel | undefined) ?? 'web') satisfies OrderChannel,
        orderType: body.orderType as string,
        lines: linesWithSnapshots,
        customer: body.customer as Record<string, unknown>,
        // NOTE: `shippingAddress` is NOT persisted on the Order doc — the
        // @classytic/order model has no address field (see order.model.ts).
        // It's accepted on the input schema but dropped by `create()`.
        // Addresses live on `Fulfillment` — we create one below with the
        // same address payload.
        payment: body.payment as Record<string, unknown> | undefined,
        sellerId: body.sellerId as string | undefined,
        typeData: body.typeData as Record<string, unknown> | undefined,
        metadata: {
          ...(body.metadata as Record<string, unknown> | undefined),
          ...(promoReservation.evaluationId ? { promoEvaluationId: promoReservation.evaluationId } : {}),
          ...(promoReservation.appliedCodes.length > 0 ? { promoCodes: promoReservation.appliedCodes } : {}),
          ...(promoReservation.totalDiscount > 0 ? { promoTotalDiscount: promoReservation.totalDiscount } : {}),
          reservationRefs: reservation.reservationRefs,
          reservationWarehouseId: reservation.warehouseId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(paymentGateway ? { paymentGateway } : {}),
        },
        idempotencyKey: idempotencyKey ?? ctx.correlationId,
      } as Record<string, unknown>,
      repoOptionsFromCtx(ctx),
    )) as Record<string, unknown>;
  } catch (err) {
    // Idempotency race recovery (unique partial index on {orgId, metadata.idempotencyKey}).
    const errObj = err as { code?: number; name?: string; message?: string };
    const isDupKey =
      errObj?.code === 11000 || (typeof errObj?.message === 'string' && /duplicate (key|value)/i.test(errObj.message));
    if (idempotencyKey && isDupKey) {
      await releaseOrderStock(reservation.reservationRefs, flowBridge, ctx, logger);
      await rollbackPromo(promoReservation, {
        actorId: ctx.actorRef,
        organizationId: ctx.organizationId as string | undefined,
        logger,
      });
      const winner = await engine.models.Order.findOne({
        organizationId: ctx.organizationId,
        'metadata.idempotencyKey': idempotencyKey,
      }).lean();
      if (winner) {
        return { status: 201, body: { success: true, data: winner, idempotent: true } };
      }
    }

    // Compensate: release both stock reservation and promo reservation.
    await releaseOrderStock(reservation.reservationRefs, flowBridge, ctx, logger);
    await rollbackPromo(promoReservation, {
      actorId: ctx.actorRef,
      organizationId: ctx.organizationId as string | undefined,
      logger,
    });
    throw err;
  }

  const promoCommit = await commitPromo(promoReservation, String(order._id), {
    actorId: ctx.actorRef,
    organizationId: ctx.organizationId as string | undefined,
    logger,
  });

  const paymentResult = isRevenueReady()
    ? await attachPaymentToOrder({
        order: order as unknown as Parameters<typeof attachPaymentToOrder>[0]['order'],
        payment: body.payment as OrderPaymentInput | undefined,
        ctx,
        bridge: createRevenueBridge(),
        idempotencyKey: `order-${String(order._id)}`,
        logger,
      })
    : { kind: 'skipped' as const, error: 'revenue_not_ready' };

  // Persist the delivery address on a Fulfillment — the canonical home
  // per @classytic/order (the Order doc itself has no address fields).
  // This is the composition the kernel expects: the host calls
  // `fulfillment.createForOrder` with the same address payload the FE
  // sent, right after `order.create` — no DB lookup, no populate.
  //
  // The FE/SDK ship a BD-retail address shape (recipientName, addressLine1,
  // areaId, ...) while the kernel's Fulfillment schema requires canonical
  // { line1, city, country }. `toFulfillmentAddress` translates between
  // them and returns null when required fields are missing (so we don't
  // let Mongoose throw on an un-savable doc).
  //
  // Best-effort: if this throws, the order is already saved and the
  // admin can create the fulfillment manually from /dashboard/orders.
  const shippingAddress = toFulfillmentAddress(
    body.shippingAddress as Record<string, unknown> | undefined,
  );
  const physicalLines = linesWithSnapshots.filter((l) => {
    const snap = (l as { snapshot?: { requiresShipping?: boolean } }).snapshot;
    return snap?.requiresShipping !== false;
  });
  if (shippingAddress && physicalLines.length > 0) {
    try {
      await engine.repositories.fulfillment.createForOrder(
        {
          orderNumber: order.orderNumber as string,
          fulfillmentType: 'physical',
          lines: physicalLines.map((l) => ({
            orderLineId: (l as { lineId: string }).lineId,
            quantity: (l as { quantity: number }).quantity,
          })),
          shippingAddress: shippingAddress as unknown as Record<string, unknown>,
        },
        ctx,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, orderNumber: order.orderNumber },
        'placement: fulfillment create failed — address not persisted, admin can create manually',
      );
    }
  }

  return { status: 201, body: { success: true, data: order, promoCommit, payment: paymentResult } };
}
