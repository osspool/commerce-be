/**
 * POS Controller — thin wrapper over `@classytic/order`.
 *
 * The POS module is just a channel for the universal order engine. Every
 * cashier checkout flows through the same `createOrder` pipeline as web
 * checkout — state machine, idempotency, FSM, fulfillment, events — with
 * `channel: 'pos'` stamped on the record and the branch's organizationId
 * resolved from the auth scope.
 *
 * Legacy POS helpers (VAT calc, cost-price filter, parcel metrics,
 * vatInvoice generation) are gone. Those concerns belong on the order
 * engine's tax bridge / loyalty bridge / fulfillment provider bridge
 * when they land — not on a bespoke POS controller.
 */

import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import logger from '#lib/utils/logger.js';
import {
  buildFlowContext,
  DEFAULT_LOCATION,
  resolveAuthorizedBranchId,
  skuRefFromProduct,
} from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import {
  commitPromo,
  reservePromo,
  rollbackPromo,
  type PromoLineItem,
} from '#resources/promotions/promo-placement.js';
import type { OrderChannel } from '../orders/channel.js';
import { ensureOrderEngine } from '../orders/order.engine.js';
import { toFulfillmentAddress } from '../orders/shipping-address.js';
import posShiftRepository from './shift.repository.js';

interface AuthenticatedUser {
  _id?: string;
  id?: string;
  [key: string]: unknown;
}

interface PosOrderItem {
  productId: string;
  variantSku?: string;
  quantity: number;
  price?: number;
}

interface PosOrderBody {
  items: PosOrderItem[];
  branchId?: string;
  branchSlug?: string;
  customer?: { id?: string; name?: string; phone?: string; email?: string };
  payments?: Array<{ method: string; amount: number; reference?: string; details?: unknown }>;
  payment?: { method: string; amount: number; reference?: string; details?: unknown };
  discount?: number;
  deliveryMethod?: 'pickup' | 'delivery';
  deliveryAddress?: Record<string, unknown>;
  deliveryPrice?: number;
  notes?: string;
  terminalId?: string;
  idempotencyKey?: string;
  /**
   * Promo codes submitted by the cashier. The server evaluates these
   * against the canonical POS cart (items + prices) — it never trusts a
   * client-computed evaluation. See `promo-placement.ts` for details.
   */
  promoCodes?: string[];
}

function buildOrderContext(req: FastifyRequest): OrderContext {
  const user = (req as unknown as { user?: AuthenticatedUser }).user;
  const actorRef = (user?._id as string | undefined) ?? (user?.id as string | undefined) ?? 'pos-anonymous';
  const orgHeader = (req.headers['x-organization-id'] as string | undefined) ?? '';
  return {
    organizationId: orgHeader,
    actorRef,
    actorKind: 'user',
    correlationId: req.id ?? `pos-${Date.now()}`,
  };
}

class PosController {
  constructor() {
    this.createOrder = this.createOrder.bind(this);
    this.getReceipt = this.getReceipt.bind(this);
  }

  /**
   * Create a POS order.
   *
   * Translates the POS body shape into the universal order pipeline input
   * and delegates to `@classytic/order`'s place-order flow. Branch is
   * resolved from auth scope (`x-organization-id` === branchId).
   */
  async createOrder(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = req.body as PosOrderBody;

    if (!body.items?.length) {
      return reply.code(400).send({ success: false, message: 'At least one item is required' });
    }

    const branchId = resolveAuthorizedBranchId(req, body.branchId);
    if (!branchId) {
      return reply.code(400).send({ success: false, message: 'Invalid branch' });
    }

    // Shift guard — every POS sale must flow through an open shift, so the
    // day's revenue is attributable to a cashier + shift for reconciliation.
    // Paused / blind_closed / closed → reject with 409.
    const activeShift = await posShiftRepository.getActiveShift(branchId);
    if (!activeShift) {
      return reply.code(409).send({
        success: false,
        code: 'NO_OPEN_SHIFT',
        message: 'No open shift for this branch — open the register first',
      });
    }
    if (activeShift.state !== 'open') {
      return reply.code(409).send({
        success: false,
        code: 'SHIFT_NOT_OPEN',
        message: `Shift is ${activeShift.state}; resume it before accepting sales`,
      });
    }

    const ctx: OrderContext = {
      ...buildOrderContext(req),
      organizationId: branchId,
    };

    const payments = body.payments ?? (body.payment ? [body.payment] : []);

    try {
      const engine = await ensureOrderEngine();

      // ─── Pre-check stock at the terminal's branch ─────────────────────────
      //
      // POS is goods-leave-on-sale. Rejecting before the order record is
      // created is cleaner than letting `order-stock-hook` fail post-commit
      // and leaving a phantom paid-but-not-decremented order.
      // The order-stock-hook still fires on success — that's where the
      // authoritative atomic decrement happens. This pre-check just shortens
      // the failure path and gives the cashier a useful 4xx response.
      const flow = getFlowEngineOrNull();
      if (flow) {
        const flowCtx = buildFlowContext(branchId, ctx.actorRef);
        const shortages: Array<{ sku: string; requested: number; available: number }> = [];
        for (const item of body.items) {
          const skuRef = skuRefFromProduct(item.productId, item.variantSku);
          const avail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, flowCtx);
          const onHand = avail.quantityOnHand ?? 0;
          if (onHand < item.quantity) {
            shortages.push({ sku: skuRef, requested: item.quantity, available: onHand });
          }
        }
        if (shortages.length > 0) {
          return reply.code(409).send({
            success: false,
            code: 'INSUFFICIENT_STOCK',
            message: 'One or more items are out of stock at this branch',
            details: shortages,
          });
        }
      }

      const lines = body.items.map((item) => ({
        kind: 'sku',
        offerId: item.variantSku ?? item.productId,
        quantity: item.quantity,
        unitPriceOverride:
          typeof item.price === 'number' ? { amount: Math.round(item.price * 100), currency: 'BDT' } : undefined,
        metadata: { productId: item.productId, variantSku: item.variantSku },
      }));

      // Server-authoritative promo evaluation — same model as storefront
      // placement. See `promo-placement.ts`. Prices from the POS body are
      // in major units; convert to paisa (minor) for the engine.
      const promoLines: PromoLineItem[] = body.items.map((item) => {
        const unitPrice = typeof item.price === 'number' ? Math.round(item.price * 100) : 0;
        return {
          productId: item.productId,
          sku: item.variantSku ?? item.productId,
          quantity: item.quantity,
          unitPrice,
          lineTotal: unitPrice * item.quantity,
        };
      });
      const promoSubtotal = promoLines.reduce((sum, l) => sum + l.lineTotal, 0);

      const promoReservation = await reservePromo({
        codes: body.promoCodes,
        lines: promoLines,
        subtotal: promoSubtotal,
        customerId: body.customer?.id,
        actorId: ctx.actorRef,
        organizationId: ctx.organizationId as string | undefined,
        logger: req.log,
      });

      let order: unknown;
      try {
        order = await engine.repositories.order.create(
          {
            channel: 'pos' satisfies OrderChannel,
            orderType: 'standard',
            lines,
            customer: body.customer ?? { name: 'Walk-in', email: 'walkin@pos.local' },
            shippingAddress: body.deliveryAddress,
            payment: payments[0]
              ? {
                  gateway: payments[0].method,
                  // Store payment amounts in paisa (minor units) — same
                  // unit as `lines[].unitPrice` and `totals.grandTotal`.
                  // Mixing major + minor units silently corrupts the
                  // shift-aggregation hook's per-method JE math.
                  paymentData: {
                    payments: payments.map((p) => ({
                      ...p,
                      amount: typeof p.amount === 'number' ? Math.round(p.amount * 100) : 0,
                    })),
                    reference: payments[0].reference,
                  },
                }
              : undefined,
            metadata: {
              terminalId: body.terminalId,
              deliveryMethod: body.deliveryMethod ?? 'pickup',
              deliveryPrice: body.deliveryPrice,
              discount: body.discount,
              notes: body.notes,
              // shiftId is read by shift-aggregation.hook to increment the
              // active shift's sales counters atomically after create.
              shiftId: String((activeShift as { _id: unknown })._id),
              ...(promoReservation.evaluationId ? { promoEvaluationId: promoReservation.evaluationId } : {}),
              ...(promoReservation.appliedCodes.length > 0 ? { promoCodes: promoReservation.appliedCodes } : {}),
              ...(promoReservation.totalDiscount > 0 ? { promoTotalDiscount: promoReservation.totalDiscount } : {}),
            },
            idempotencyKey: body.idempotencyKey,
          } as Record<string, unknown>,
          repoOptionsFromCtx(ctx),
        );
      } catch (err) {
        // Release the promo reservation so the voucher stays available.
        await rollbackPromo(promoReservation, {
          actorId: ctx.actorRef,
          organizationId: ctx.organizationId as string | undefined,
          logger: req.log,
        });
        throw err;
      }

      const promoCommit = await commitPromo(promoReservation, String((order as { _id: unknown })._id), {
        actorId: ctx.actorRef,
        organizationId: ctx.organizationId as string | undefined,
        logger: req.log,
      });

      // ─── Delivery fulfillment (opt-in, not the POS default) ──────────────
      //
      // POS is walk-in-first: most orders are `deliveryMethod: 'pickup'`, the
      // cashier hands the customer the goods at the counter, and the stock
      // decrement fires from `wireOrderStockHook`. No fulfillment / no
      // shipping address required.
      //
      // But some in-store customers want delivery instead ("ship it to my
      // house"). For those we follow the same pattern as /orders/place:
      // persist the address on a Fulfillment record so the logistics
      // module can dispatch it (logistics.service reads from the
      // fulfillment's shippingAddress — see logistics/CLAUDE.md).
      //
      // Best-effort: the order + payment are already committed, so a
      // failure here just leaves the admin to create the fulfillment
      // manually from /dashboard/orders/:id. It does NOT fail the sale.
      const needsDelivery = body.deliveryMethod === 'delivery';
      const shippingAddress = toFulfillmentAddress(body.deliveryAddress);
      if (needsDelivery && shippingAddress) {
        const createdOrder = order as {
          orderNumber?: string;
          lines?: Array<{
            lineId?: string;
            quantity: number;
            snapshot?: { requiresShipping?: boolean };
          }>;
        };
        const physicalLines = (createdOrder.lines ?? []).filter(
          (l) => l.snapshot?.requiresShipping !== false,
        );
        if (createdOrder.orderNumber && physicalLines.length > 0) {
          try {
            await engine.repositories.fulfillment.createForOrder(
              {
                orderNumber: createdOrder.orderNumber,
                fulfillmentType: 'physical',
                lines: physicalLines.map((l) => ({
                  orderLineId: l.lineId ?? '',
                  quantity: l.quantity,
                })),
                shippingAddress: shippingAddress as unknown as Record<string, unknown>,
              },
              ctx,
            );
          } catch (err) {
            req.log.warn(
              { err: (err as Error).message, orderNumber: createdOrder.orderNumber },
              'POS: fulfillment create failed — address not persisted, admin can create manually',
            );
          }
        }
      }

      return reply.code(201).send({ success: true, data: order, promoCommit });
    } catch (err) {
      logger.error({ err }, 'POS createOrder failed');
      const message = (err as Error).message ?? 'POS order creation failed';
      return reply.code(400).send({ success: false, message });
    }
  }

  /**
   * Fetch a POS order by `orderNumber` for receipt rendering. Scoped to
   * the caller's branch via the multi-tenant plugin.
   */
  async getReceipt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { orderId } = req.params as { orderId: string };
    const ctx = buildOrderContext(req);

    try {
      const engine = await ensureOrderEngine();
      const order = await engine.repositories.order.getByQuery({ orderNumber: orderId }, repoOptionsFromCtx(ctx));
      if (!order) {
        return reply.code(404).send({ success: false, message: 'Order not found' });
      }
      return reply.send({ success: true, data: order });
    } catch (err) {
      logger.error({ err }, 'POS getReceipt failed');
      return reply.code(500).send({ success: false, message: 'Receipt fetch failed' });
    }
  }
}

const posController = new PosController();
export default posController;
