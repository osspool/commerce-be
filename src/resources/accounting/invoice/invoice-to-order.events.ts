/**
 * Invoice → Order reverse event bridge.
 *
 * When a customer invoice created from an Order (sourceType: 'Order') is
 * fully paid, signal the order engine so the order's paymentState reflects
 * settlement. Fulfillment subscribers and downstream dashboards can then
 * see the order as payment-complete without polling the invoice module.
 *
 * Why this bridge exists:
 *   - `@classytic/invoice` emits `invoice:paid` when amountDue hits zero.
 *   - `@classytic/order` tracks paymentState per order but has no built-in
 *     subscriber for invoice events (intentional — packages don't import
 *     siblings). The app wires them together.
 *
 * Idempotency: updatePaymentState is a partial $set on a subdocument —
 * safe to call multiple times. No guard needed.
 */

import type { DomainEvent } from '@classytic/primitives/events';
import type { OrderContext } from '@classytic/order';
import type { FastifyInstance } from 'fastify';
import logger from '#lib/utils/logger.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';

export function registerInvoiceToOrderBridge(fastify: FastifyInstance): void {
  if (!fastify.events) return;

  fastify.events.subscribe('invoice:paid', async (event: DomainEvent) => {
    try {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const sourceType = payload.sourceType as string | undefined;
      const sourceId = payload.sourceId as string | undefined;

      // Only bridge when the invoice originates from an order. Vendor bills
      // (sourceType: 'Purchase'), POS receipts (sourceType: 'POS'), and
      // ad-hoc invoices don't need a back-channel to the order module.
      if (sourceType !== 'Order' || !sourceId) return;

      const orgId = (payload.organizationId as string | undefined) ?? event.meta?.organizationId;
      if (!orgId) return;

      const engine = await ensureOrderEngine();
      const ctx: OrderContext = {
        organizationId: orgId,
        actorRef: event.meta?.userId ?? 'invoice-bridge',
        actorKind: 'system',
        correlationId: event.meta?.correlationId ?? '',
      };

      // Use the orthogonal payment-state shape (Saleor-style, see
      // packages/order/src/domain/value-objects/payment-state.vo.ts).
      // `chargeStatus: 'full'` signals "this order's balance is settled".
      // `updatePaymentState` is a partial $set — other fields (authorize,
      // escrow, revenue transaction refs) are untouched.
      await engine.repositories.order.updatePaymentState(
        sourceId,
        { chargeStatus: 'full' } as Record<string, unknown>,
        ctx,
      );

      logger.info(
        { orderNumber: sourceId, invoiceId: payload.invoiceId },
        '[invoice→order] paymentState=paid after invoice:paid',
      );
    } catch (err) {
      // Never block the event bus — log and move on. Invoice accounting is
      // the source of truth; order paymentState is a projection.
      logger.error({ err, event: 'invoice:paid' }, '[invoice→order] bridge failed');
    }
  });
}
