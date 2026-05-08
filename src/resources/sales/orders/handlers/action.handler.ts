import type { FastifyReply, FastifyRequest } from 'fastify';
import { publish } from '#lib/events/arcEvents.js';
import { createFlowBridge } from '../bridges/flow.bridge.js';
import { ensureOrderEngine } from '../order.engine.js';
import { releaseOrderStock } from '../order-placement.js';
import { getOrderContext } from './shared.js';
import { NotFoundError, ValidationError, createDomainError } from '@classytic/arc/utils';

/**
 * `ship` and `fulfill` are the dashboard-friendly verbs for "deliver this
 * order's goods to the customer". Server-side they don't transition the
 * order FSM directly — instead they create a Fulfillment for the
 * outstanding lines and transition it to `shipped`. The fulfillment FSM
 * event drives the lifecycle handlers (stock-commit-on-ship,
 * ledger-cogs-bridge) so inventory + accounting stay on a single canonical
 * path: the Fulfillment doc.
 */
const SHIP_ACTIONS = new Set(['ship', 'fulfill']);

const statusMap: Record<string, string> = {
  confirm: 'confirmed',
  process: 'processing',
  complete: 'completed',
  cancel: 'canceled',
  refund: 'refunded',
  hold: 'on_hold',
  release_hold: 'confirmed',
  approve_fraud: 'confirmed',
};

export async function orderActionHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const body = req.body as { action: string; reason?: string };
  const ctx = getOrderContext(req);

  const scoped = await engine.repositories.order.getByQuery(
    { orderNumber: id, organizationId: ctx.organizationId },
    { throwOnNotFound: false },
  );
  if (!scoped) {
    // NotFoundError(resource, identifier) formats as either
    //   "<resource> with identifier '<id>' not found"  (when id is set)
    //   "<resource> not found"                          (without id)
    // Passing 'Order not found' as the resource would yield
    // "Order not found not found" — see [arc/src/utils/errors.ts].
    throw new NotFoundError('Order', id);
  }

  // ── Ship-shaped actions: create + transition a Fulfillment ─────────
  //
  // Inventory authority lives on the Fulfillment doc — see Odoo
  // (stock.picking), ERPNext (Delivery Note), Shopify (Fulfillment).
  // The order FSM moves to `fulfilled` AFTER the fulfillment commits so
  // the order's primary status reflects admin intent, but the inventory
  // and COGS side-effects flow off the fulfillment event subscribers.
  if (SHIP_ACTIONS.has(body.action)) {
    const orderDoc = scoped as {
      _id: unknown;
      status?: string;
      orderNumber: string;
      fulfillmentSummary?: { total?: number; shipped?: number; fulfilled?: number; delivered?: number };
      lines?: Array<{ lineId?: string; quantity?: number; snapshot?: { requiresShipping?: boolean } }>;
    };

    // Guard against re-shipping an already-shipped/fulfilled order.
    // Without this, hitting `POST /:id/action {action:'ship'}` repeatedly
    // creates a new Fulfillment doc on each call (orders.fulfillmentSummary
    // accumulates), which leads to operational drift (duplicate carrier
    // shipments, duplicate label prints, downstream subscribers double-
    // firing). Other illegal transitions (cancel-fulfilled, refund-canceled,
    // ...) reject with 422 illegal_transition; ship should match.
    const terminalStatuses = new Set([
      'fulfilled',
      'completed',
      'canceled',
      'refunded',
      'shipped',
    ]);
    const summary = orderDoc.fulfillmentSummary;
    const orderInTerminalStatus = orderDoc.status && terminalStatuses.has(orderDoc.status);
    const allLinesShipped =
      summary !== undefined &&
      typeof summary.total === 'number' &&
      summary.total > 0 &&
      typeof summary.shipped === 'number' &&
      summary.shipped >= summary.total;
    if (orderInTerminalStatus || allLinesShipped) {
      throw createDomainError(
        'illegal_transition',
        `Invalid transition for order ${id}: ${orderDoc.status ?? 'order'} → ${body.action}`,
        422,
      );
    }

    const physicalLines = (orderDoc.lines ?? []).filter((line) => {
      const requiresShipping = line.snapshot?.requiresShipping;
      return requiresShipping !== false && line.lineId && (line.quantity ?? 0) > 0;
    });
    if (physicalLines.length === 0) {
      throw createDomainError('NO_SHIPPABLE_LINES', 'Order has no shippable lines', 400);
    }

    const fulfillment = await engine.repositories.fulfillment.createForOrder(
      {
        orderNumber: orderDoc.orderNumber,
        fulfillmentType: 'physical',
        lines: physicalLines.map((line) => ({
          orderLineId: line.lineId as string,
          quantity: line.quantity as number,
        })),
      },
      ctx,
    );
    await engine.repositories.fulfillment.transition(
      (fulfillment as { fulfillmentNumber: string }).fulfillmentNumber,
      'shipped',
      ctx,
    );

    // Reflect the fulfillment commit on the order's primary FSM so
    // dashboards and downstream readers don't need to derive status from
    // fulfillmentSummary. Best-effort — if the order's FSM rejects the
    // transition (e.g. already `completed`), the inventory + COGS already
    // landed via the fulfillment event subscribers.
    let order: unknown = orderDoc;
    try {
      order = await engine.repositories.order.transition(id, 'fulfilled', ctx, {
        reason: body.reason,
      });
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message, orderId: id },
        'Order FSM transition to fulfilled failed (fulfillment already shipped)',
      );
    }
    return reply.send(order);
  }

  // ── Plain FSM transitions (confirm / cancel / refund / hold / ...) ──
  const targetStatus = statusMap[body.action] ?? body.action;
  const order = await engine.repositories.order.transition(id, targetStatus, ctx, {
    reason: body.reason,
  });

  if (body.action === 'cancel' || body.action === 'refund') {
    const meta = (
      order as {
        metadata?: {
          reservationRefs?: Array<{ lineId: string; reservationId: string; skuRef: string; quantity: number }>;
          codSettlement?: { actualReceived: number; courierCommission: number; writeoff: number };
        };
        totals?: { grandTotal?: { amount: number; currency: string }; tax?: { amount: number } };
      }
    ).metadata;
    const refs = meta?.reservationRefs ?? [];
    if (refs.length > 0) {
      const flowBridge = createFlowBridge();
      await releaseOrderStock(refs, flowBridge, ctx, req.log);
    }

    const gateway = String((meta as Record<string, unknown> | undefined)?.paymentGateway ?? '').toLowerCase();
    const alreadySettled = !!meta?.codSettlement;
    if (gateway === 'cod' && !alreadySettled) {
      const totals = (order as { totals?: { grandTotal?: { amount: number }; tax?: { amount: number } } }).totals;
      const grossAmount = totals?.grandTotal?.amount ?? 0;
      const tax = totals?.tax?.amount ?? 0;
      const promoDiscount = Number((meta as Record<string, unknown> | undefined)?.promoTotalDiscount ?? 0);
      if (grossAmount > 0) {
        const customerId = (order as { customerId?: { toString(): string } | string | null }).customerId;
        await publish('accounting:cod.cancelled', {
          orderId: String((order as { _id: unknown })._id),
          customerId: customerId ? String(customerId) : null,
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

  return reply.send(order);
}
