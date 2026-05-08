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
import { resolveCustomerPriceList } from './customer-pricelist.js';
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
    return {
      status: 400,
      body: { code: 'arc.validation', status: 400, message: 'Order must contain at least one line' },
    };
  }

  // Idempotency lookup + pricelist resolution are independent reads — run
  // them in parallel. On the common path (no idempotency key OR fresh key)
  // both queries are needed, so the cost is one round-trip instead of two.
  // On the rare retry path (idempotency hit) we waste the pricelist call,
  // but retries are infrequent enough that the tradeoff favors the hot path.
  const idempotencyKey = (body.idempotencyKey as string | undefined) ?? undefined;
  const customerForPricelist = body.customer as { _id?: string; email?: string } | undefined;

  const [existingByIdempotency, pricelistResolution] = await Promise.all([
    idempotencyKey
      ? engine.models.Order.findOne({
          organizationId: ctx.organizationId,
          'metadata.idempotencyKey': idempotencyKey,
        }).lean()
      : Promise.resolve(null),
    resolveCustomerPriceList(customerForPricelist, ctx.organizationId),
  ]);

  if (existingByIdempotency) {
    const plain = (existingByIdempotency as unknown) as Record<string, unknown>;
    return { status: 201, body: { ...plain, idempotent: true } };
  }

  if (pricelistResolution) {
    logger.debug?.(
      { customerId: pricelistResolution.customerId, priceListId: pricelistResolution.priceListId },
      'Applying customer pricelist to order placement',
    );
  }

  // Resolve SKUs so we can reserve stock
  const catalogBridge = createCatalogBridge();
  const resolvedLines = await resolveLineSkus(rawLines, catalogBridge, ctx, {
    priceListId: pricelistResolution?.priceListId,
  });
  if (!resolvedLines) {
    return {
      status: 400,
      body: { code: 'arc.validation', status: 400, message: 'Failed to resolve one or more line SKUs' },
    };
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
          code: 'INSUFFICIENT_STOCK',
          status: 409,
          message: (err as Error).message || 'Insufficient stock for one or more items',
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
    // Promote the promo-evaluation discount onto the canonical
    // `totals.discount` so the order kernel re-derives `grandTotal` with the
    // discount applied. The kernel reads `data.discount` as a Money object
    // (see `composeTotals` in @classytic/order). Without this, the order
    // would persist with `totals.discount: 0` and a grand total equal to
    // subtotal — even though we already committed the promo redemption.
    const promoDiscount =
      promoReservation.totalDiscount > 0
        ? { amount: promoReservation.totalDiscount, currency: 'BDT' }
        : undefined;

    // Forward the FE-quoted delivery charge so the order's `totals.shipping`
    // and `grandTotal` reflect what the customer was shown. The FE quotes
    // `delivery.price` in BDT major units (matching how the cart lines are
    // displayed), while the kernel persists Money in paisa — convert here
    // at the boundary instead of mixing units inside the kernel.
    const deliveryPrice = (body.delivery as { price?: number } | undefined)?.price;
    const promoShipping =
      typeof deliveryPrice === 'number' && deliveryPrice > 0
        ? { amount: Math.round(deliveryPrice * 100), currency: 'BDT' }
        : undefined;

    order = (await engine.repositories.order.create(
      {
        channel: (forceChannel ?? (body.channel as OrderChannel | undefined) ?? 'web') satisfies OrderChannel,
        orderType: body.orderType as string,
        lines: linesWithSnapshots,
        ...(promoDiscount ? { discount: promoDiscount } : {}),
        ...(promoShipping ? { shipping: promoShipping } : {}),
        customer: body.customer as Record<string, unknown>,
        // Snapshot the checkout-time addresses on the Order doc (kernel
        // 0.1.3+). Per-fulfillment overrides still live on
        // `Fulfillment.shippingAddress` for split-shipment cases; this is
        // the default a customer sees on /profile/my-orders.
        ...(body.shippingAddress ? { shippingAddress: body.shippingAddress as Record<string, unknown> } : {}),
        ...(body.billingAddress ? { billingAddress: body.billingAddress as Record<string, unknown> } : {}),
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
        return { status: 201, body: { ...(winner as unknown as Record<string, unknown>), idempotent: true } };
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

  // Note: Fulfillment doc auto-creation used to happen here, but it was
  // failing silently (the order kernel auto-generates `lineId: line_${i}`
  // internally, while we passed `linesWithSnapshots` which carry no
  // `lineId` — so `createForOrder` rejected the request as "sku/skuRef/
  // name required"). With the new lifecycle handlers in
  // `lifecycle/handlers/stock-commit.ts`, inventory automation runs off
  // the order FSM and no longer requires a Fulfillment doc to fire. The
  // Fulfillment record stays useful for carrier tracking metadata
  // (Pathao/RedX slip numbers, shipped-at timestamps), so it's now
  // created on demand by the carrier-integration code path with the
  // correct lineId values resolved from the persisted order — see
  // `engine.repositories.fulfillment.createForOrder` callers under
  // `resources/logistics/`.

  // Spread the order doc + extras into a plain payload so the wire shape is
  // flat (Arc 2.13). Mongoose docs don't spread their public fields, so
  // call `.toObject()` first when available.
  const orderPlain =
    typeof (order as { toObject?: () => unknown }).toObject === 'function'
      ? ((order as { toObject: () => Record<string, unknown> }).toObject() as Record<string, unknown>)
      : (order as Record<string, unknown>);
  return { status: 201, body: { ...orderPlain, promoCommit, payment: paymentResult } };
}
