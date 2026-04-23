/**
 * Invoice Event Handlers — auto-invoicing from commerce events.
 *
 * All handlers are policy-gated via config.invoice.auto* settings.
 * When policy is 'off', the handler is a no-op (manual invoicing only).
 */

import type { DomainEvent } from '@classytic/arc/events';
import type { FastifyInstance } from 'fastify';
import config from '#config/index.js';
import logger from '#lib/utils/logger.js';
import { invoice } from './invoice-engine.js';

export function registerInvoiceEventHandlers(fastify: FastifyInstance): void {
  if (!fastify.events) return;

  const { subscribe } = fastify.events;

  // ── B2B Credit Sales ────────────────────────────────────────────────────
  // Triggered when an order is paid with credit terms (not prepaid).
  // Policy: INVOICE_AUTO_SALES = 'on_order' | 'on_payment'

  if (config.invoice.autoSales !== 'off') {
    subscribe('accounting:order.paid', async (event: DomainEvent) => {
      try {
        const data = (event.payload ?? {}) as Record<string, unknown>;

        // Only credit sales — prepaid orders don't need invoices
        if (data.paymentMethod !== 'credit') return;

        const orgId = data.organizationId as string | undefined;
        if (!orgId) return;

        await invoice().record.createAndPost(
          {
            moveType: 'out_invoice',
            partnerId: data.customerId as string,
            partnerName: data.customerName as string | undefined,
            sourceType: 'Order',
            sourceId: data.orderId as string,
            lines: [
              {
                description: `Order ${data.orderNumber ?? data.orderId}`,
                quantity: 1,
                unitPrice: data.totalAmount as number,
              },
            ],
            idempotencyKey: `auto-inv-order-${data.orderId}`,
          },
          { organizationId: orgId },
        );

        logger.info({ orderId: data.orderId }, 'Auto-created customer invoice from order');
      } catch (err) {
        logger.error({ err, event: 'accounting:order.paid' }, 'Failed to auto-create invoice');
      }
    });
  }

  // ── Purchase Received → Vendor Bill ─────────────────────────────────────
  // Policy: INVOICE_AUTO_PURCHASE = 'on_receive'

  if (config.invoice.autoPurchase !== 'off') {
    subscribe('purchase:received', async (event: DomainEvent) => {
      try {
        const data = (event.payload ?? {}) as Record<string, unknown>;

        const orgId = data.organizationId as string | undefined;
        if (!orgId) return;

        await invoice().record.createAndPost(
          {
            moveType: 'in_invoice',
            partnerId: data.supplierId as string,
            partnerName: data.supplierName as string | undefined,
            sourceType: 'Purchase',
            sourceId: data.purchaseId as string,
            lines: [
              {
                description: `Purchase ${data.purchaseNumber ?? data.purchaseId}`,
                quantity: 1,
                unitPrice: data.totalAmount as number,
              },
            ],
            idempotencyKey: `auto-bill-purchase-${data.purchaseId}`,
          },
          { organizationId: orgId },
        );

        logger.info({ purchaseId: data.purchaseId }, 'Auto-created vendor bill from purchase');
      } catch (err) {
        logger.error({ err, event: 'purchase:received' }, 'Failed to auto-create vendor bill');
      }
    });
  }

  // ── POS Day Close → Receipt ─────────────────────────────────────────────
  // Policy: INVOICE_AUTO_POS = 'receipt_per_day' | 'receipt_per_txn'

  if (config.invoice.autoPOS === 'receipt_per_day') {
    subscribe('accounting:day.auto-close', async (event: DomainEvent) => {
      try {
        const data = (event.payload ?? {}) as Record<string, unknown>;

        const orgId = data.organizationId as string | undefined;
        if (!orgId) return;

        const totalAmount = data.totalAmount as number;
        if (!totalAmount || totalAmount <= 0) return;

        await invoice().repositories.invoices.createReceipt(
          {
            partnerId: 'pos-daily',
            partnerName: `POS Daily - ${data.date}`,
            lines: [
              {
                description: `POS Sales ${data.date}`,
                quantity: 1,
                unitPrice: totalAmount,
              },
            ],
            sourceType: 'POS',
            sourceId: `pos-day-${orgId}-${data.date}`,
          },
          { organizationId: orgId },
        );

        logger.info({ orgId, date: data.date }, 'Auto-created POS daily receipt');
      } catch (err) {
        logger.error({ err, event: 'accounting:day.auto-close' }, 'Failed to auto-create POS receipt');
      }
    });
  }
}
