/**
 * Invoice Event Handlers — auto-invoicing from commerce events.
 *
 * Each handler is policy-gated via `config.invoice.auto*` settings.
 * When the policy is `'off'`, the handler is never registered.
 *
 * Cross-cutting concerns (Zod payload validation, structured error
 * boundary, no-op on bad payload) are wired via Arc's:
 *   - `wrapWithSchema` — validates `event.payload` against the
 *     accounting `EventDefinitionOutput<T>`s registered in the
 *     central event registry. Handler receives `event.payload: T`.
 *   - `wrapWithBoundary` — catches handler exceptions and structures
 *     the log so a single bad invoice creation doesn't poison the bus.
 *
 * Composition: `subscribe(name, wrapWithBoundary(wrapWithSchema(...)))`
 * — schema validation runs first; whatever survives gets the boundary.
 */

import { type ValidationResult, wrapWithBoundary, wrapWithSchema } from '@classytic/arc/events';
import type { EventLogger } from '@classytic/primitives/events';
import config from '#config/index.js';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { sanitizeDisplayName } from '#resources/sales/customers/customer.name-utils.js';
import {
  OrderPaidEvent,
  PurchaseReceivedEvent,
  orderPaidSchema,
  purchaseReceivedSchema,
} from '../events/event-definitions.js';
import { invoice } from './invoice-engine.js';
import { z } from 'zod';

const eventLogger = logger as unknown as EventLogger;

// ─── Local schemas (events not yet registered as EventDefinitions) ──────

const dayCloseSchema = z.object({
  organizationId: z.string().optional(),
  totalAmount: z.number().optional(),
  date: z.string().optional(),
});

// ─── Reusable Zod-into-Arc adapter ──────────────────────────────────────

function zodValidator<T>(schema: z.ZodType<T>): (s: unknown, p: unknown) => ValidationResult {
  return (_s, p) => {
    const parsed = schema.safeParse(p);
    return parsed.success
      ? { valid: true }
      : { valid: false, errors: parsed.error.issues.map((i) => i.message) };
  };
}

// ─── Registration ───────────────────────────────────────────────────────

export function registerInvoiceEventHandlers(): void {
  // ── B2B Credit Sales: order paid → customer invoice ──
  // Policy: INVOICE_AUTO_SALES = 'on_order' | 'on_payment' | 'off'
  // The accounting OrderPaid payload only carries `transactionId`.
  // Customer-invoice creation needs the order shape (customerId,
  // paymentMethod, totalAmount), so we accept a wider local shape and
  // skip if the host that publishes hasn't enriched it yet.
  if (config.invoice.autoSales !== 'off') {
    const enrichedOrderPaidSchema = orderPaidSchema.extend({
      paymentMethod: z.string().optional(),
      organizationId: z.string().optional(),
      customerId: z.string().optional(),
      customerName: z.string().optional(),
      orderId: z.string().optional(),
      orderNumber: z.string().optional(),
      totalAmount: z.number().optional(),
    });

    void subscribe(
      OrderPaidEvent.name,
      wrapWithBoundary(
        wrapWithSchema(
          OrderPaidEvent,
          async (event) => {
            const data = enrichedOrderPaidSchema.parse(event.payload);
            if (data.paymentMethod !== 'credit') return;
            if (!data.organizationId || !data.customerId || !data.orderId) return;
            if (data.totalAmount == null) return;

            // Snapshot guard: `data.customerName` rides on the OrderPaid
            // event payload and originates upstream from `customer.name`.
            // Sanitize before persisting onto the invoice — empty/token-
            // shaped strings degrade to `undefined` so the invoice's
            // partner-name renderer falls through to its fallback rather
            // than printing `gcqAUBgGpRnDZbyPgKbS` on the customer's bill.
            const partnerName = sanitizeDisplayName(data.customerName, '') || undefined;
            await invoice().record.createAndPost(
              {
                moveType: 'out_invoice',
                partnerId: data.customerId,
                partnerName,
                sourceType: 'Order',
                sourceId: data.orderId,
                lines: [
                  {
                    description: `Order ${data.orderNumber ?? data.orderId}`,
                    quantity: 1,
                    unitPrice: data.totalAmount,
                  },
                ],
                idempotencyKey: `auto-inv-order-${data.orderId}`,
              },
              { organizationId: data.organizationId },
            );

            logger.info({ orderId: data.orderId }, 'Auto-created customer invoice from order');
          },
          {
            validate: zodValidator(orderPaidSchema),
            onInvalid: (_e, errors) =>
              logger.warn(
                { event: OrderPaidEvent.name, errors },
                'invoice: payload validation failed — skipping',
              ),
            logger: eventLogger,
          },
        ),
        { name: `invoice:${OrderPaidEvent.name}`, logger: eventLogger },
      ),
    );
  }

  // ── Purchase Received → vendor bill ──
  // Policy: INVOICE_AUTO_PURCHASE = 'on_receive' | 'off'
  if (config.invoice.autoPurchase !== 'off') {
    const enrichedPurchaseReceivedSchema = purchaseReceivedSchema.extend({
      supplierId: z.string().optional(),
      supplierName: z.string().optional(),
      purchaseNumber: z.string().optional(),
      totalAmount: z.number().optional(),
    });

    void subscribe(
      PurchaseReceivedEvent.name,
      wrapWithBoundary(
        wrapWithSchema(
          PurchaseReceivedEvent,
          async (event) => {
            const data = enrichedPurchaseReceivedSchema.parse(event.payload);
            if (!data.organizationId || !data.supplierId || !data.purchaseId) return;
            if (data.totalAmount == null) return;

            await invoice().record.createAndPost(
              {
                moveType: 'in_invoice',
                partnerId: data.supplierId,
                partnerName: data.supplierName,
                sourceType: 'Purchase',
                sourceId: data.purchaseId,
                lines: [
                  {
                    description: `Purchase ${data.purchaseNumber ?? data.purchaseId}`,
                    quantity: 1,
                    unitPrice: data.totalAmount,
                  },
                ],
                idempotencyKey: `auto-bill-purchase-${data.purchaseId}`,
              },
              { organizationId: data.organizationId },
            );

            logger.info(
              { purchaseId: data.purchaseId },
              'Auto-created vendor bill from purchase',
            );
          },
          {
            validate: zodValidator(purchaseReceivedSchema),
            onInvalid: (_e, errors) =>
              logger.warn(
                { event: PurchaseReceivedEvent.name, errors },
                'invoice: payload validation failed — skipping',
              ),
            logger: eventLogger,
          },
        ),
        { name: `invoice:${PurchaseReceivedEvent.name}`, logger: eventLogger },
      ),
    );
  }

  // ── POS Day Close → daily receipt ──
  // Policy: INVOICE_AUTO_POS = 'receipt_per_day' | 'receipt_per_txn' | 'off'
  // `accounting:day.auto-close` is not an EventDefinition yet (the day-
  // close path itself is being phased out per accounting.events.ts §POS).
  // Use a plain boundary subscriber until that stabilises.
  if (config.invoice.autoPOS === 'receipt_per_day') {
    void subscribe(
      'accounting:day.auto-close',
      wrapWithBoundary(
        async (event) => {
          const data = dayCloseSchema.parse(event.payload);
          if (!data.organizationId || !data.totalAmount || data.totalAmount <= 0) return;

          await invoice().repositories.invoices.createReceipt(
            {
              partnerId: 'pos-daily',
              partnerName: `POS Daily - ${data.date}`,
              lines: [
                {
                  description: `POS Sales ${data.date}`,
                  quantity: 1,
                  unitPrice: data.totalAmount,
                },
              ],
              sourceType: 'POS',
              sourceId: `pos-day-${data.organizationId}-${data.date}`,
            },
            { organizationId: data.organizationId },
          );

          logger.info(
            { orgId: data.organizationId, date: data.date },
            'Auto-created POS daily receipt',
          );
        },
        { name: 'invoice:accounting:day.auto-close', logger: eventLogger },
      ),
    );
  }
}
