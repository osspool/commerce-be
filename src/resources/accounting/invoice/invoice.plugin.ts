/**
 * Invoice Plugin — bootstraps the invoice engine at app startup.
 *
 * 1. Passes Arc's `fastify.events` directly into the invoice engine's
 *    `eventTransport` slot (no adapter — shapes are structurally identical).
 * 2. Initializes the engine singleton (uses @classytic/ledger's createLedgerBridge).
 *    The shared MongoOutboxStore is wired in the engine config itself so the
 *    repository persists every domain event to the outbox atomically with the
 *    document write (PACKAGE_RULES §P8). No post-init hook registration.
 * 3. Registers event-driven auto-invoicing (policy-gated).
 *
 * Dunning + recurring are handled by @classytic/streamline workflows
 * (see invoice.workflows.ts), NOT cron jobs. The /dunning/process and
 * /recurring/process endpoints still exist for manual trigger / testing.
 */

import type { FastifyInstance } from 'fastify';
import config from '#config/index.js';
import { registerInvoiceEventHandlers } from './invoice.events.js';
import { buildInvoiceResource } from './invoice.resource.js';
import { initializeInvoiceEngine } from './invoice-engine.js';
import { registerInvoiceToOrderBridge } from './invoice-to-order.events.js';
import { buildPaymentTermResource } from './payment-term.resource.js';
import { buildRecurringInvoiceResource } from './recurring-invoice.resource.js';

async function invoicePlugin(fastify: FastifyInstance): Promise<void> {
  if (!config.invoice.engine) return;

  const engine = initializeInvoiceEngine(fastify.events);

  if (engine.models?.Invoice && engine.repositories?.invoices) {
    const fullResource = await buildInvoiceResource(engine.models.Invoice, engine.repositories.invoices);
    await fastify.register(fullResource.toPlugin());
  }

  // Sibling resources extracted from invoice.resource.ts — top-level CRUD
  // via createMongooseAdapter, no more raw routes hidden under /invoices/*.
  if (engine.models?.PaymentTerm && engine.repositories?.paymentTerms) {
    const paymentTermResource = buildPaymentTermResource(engine.models.PaymentTerm, engine.repositories.paymentTerms);
    await fastify.register(paymentTermResource.toPlugin());
  }
  if (engine.models?.RecurringInvoice && engine.repositories?.recurringInvoices) {
    const recurringResource = buildRecurringInvoiceResource(
      engine.models.RecurringInvoice,
      engine.repositories.recurringInvoices,
    );
    await fastify.register(recurringResource.toPlugin());
  }

  fastify.log.info(
    {
      invoiceEngine: true,
      ledgerBridge: true,
      arcEvents: !!fastify.events,
      outboxWired: true,
      autoSales: config.invoice.autoSales,
      autoPurchase: config.invoice.autoPurchase,
      autoPOS: config.invoice.autoPOS,
    },
    'Invoice engine initialized',
  );

  registerInvoiceEventHandlers(fastify);

  // Reverse bridge: invoice:paid → order paymentState=paid when the invoice
  // originated from an Order. See invoice-to-order.events.ts.
  registerInvoiceToOrderBridge(fastify);
}

export default invoicePlugin;
