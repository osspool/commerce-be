/**
 * Invoice Engine Singleton
 *
 * The invoice engine consumes the `LedgerBridge` port — whether to back it
 * with our in-house @classytic/ledger, QuickBooks, Xero, or a no-op is an
 * app-level decision. See `bridges/ledger-classytic.bridge.ts` for the
 * current wiring and parallel-file pattern for alternate ledgers.
 *
 * Event wiring: the invoice engine's `eventTransport` expects the raw
 * `@classytic/arc/events` `EventTransport` shape (`publish(event)` takes a
 * full `DomainEvent` envelope). Arc's `fastify.events` decorator is a
 * convenience wrapper (`publish(type, payload, meta)`), so we adapt it with
 * a ~15-line shim. Every `invoice:*` event still flows through the same
 * underlying Arc transport — outbox, WAL, retry, DLQ all apply.
 */

import type { DomainEvent, EventHandler, EventTransport, InvoiceEngine } from '@classytic/invoice';
import { createInvoiceEngine } from '@classytic/invoice';
import type { InvoiceNotificationPayload, NotificationBridge } from '@classytic/invoice/domain/contracts';
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import config from '#config/index.js';
import { notify } from '#shared/notifications/index.js';
import { outboxStore } from '#shared/outbox/index.js';
import { createCatalogBridgeForInvoice } from './bridges/catalog.bridge.js';
import { createClassyticLedgerBridge } from './bridges/ledger-classytic.bridge.js';
import { createPartnerBridge } from './bridges/partner.bridge.js';
import { createPdfBridge } from './bridges/pdf.bridge.js';

// ── Arc Event Transport Adapter ───────────────────────────────────────────────
// Arc's `fastify.events` decorator splits publish into (type, payload, meta)
// and does not expose the underlying `EventTransport` directly. The invoice
// engine expects the raw `publish(event: DomainEvent)` shape, so this adapter
// forwards one to the other. Handler signatures already match.

type ArcFastifyEvents = FastifyInstance['events'];

function adaptArcEvents(fastifyEvents: ArcFastifyEvents): EventTransport {
  return {
    name: `arc:${fastifyEvents.transportName}`,
    async publish(event: DomainEvent): Promise<void> {
      // fastifyEvents.publish will re-run createEvent, but passing our meta
      // preserves id/timestamp/userId/organizationId/correlationId because
      // Arc's createEvent spreads `...meta` over its defaults.
      await fastifyEvents.publish(event.type, event.payload, event.meta);
    },
    async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
      return fastifyEvents.subscribe(pattern, handler);
    },
  };
}

// ── Notification Bridge ──────────────────────────────────────────────────────
// Thin adapter over be-prod's `notify()` helper. Recipient email / phone is
// resolved by the engine via the PartnerBridge — this bridge only sends.

function createNotificationBridge(): NotificationBridge {
  return {
    async send(payload: InvoiceNotificationPayload) {
      const email = payload.recipient.email;
      if (!email) return; // no email on file — skip silently

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const invoiceId = payload.data?.invoiceId as string;

      await notify(payload.template ?? payload.event, email, {
        ...payload.data,
        recipientName: payload.recipient.name,
        invoiceUrl: invoiceId ? `${frontendUrl}/dashboard/accounting/invoices/${invoiceId}/print` : frontendUrl,
      });
    },
  };
}

// ── Engine Singleton ──────────────────────────────────────────────────────────

let engine: InvoiceEngine | null = null;

/**
 * Initialize the invoice engine singleton.
 *
 * @param fastifyEvents Optional Arc `fastify.events` decorator. When passed,
 *   every invoice domain event flows through Arc's bus (outbox, WAL, retry,
 *   DLQ, webhooks, SSE, Redis/Kafka). Omit to fall back to the package's
 *   in-process bus — fine for tests and scripts.
 */
export function initializeInvoiceEngine(fastifyEvents?: ArcFastifyEvents): InvoiceEngine {
  if (engine) return engine;

  const eventTransport: EventTransport | undefined = fastifyEvents ? adaptArcEvents(fastifyEvents) : undefined;

  // Ledger integration is pluggable. Swap this line to wire in a different
  // ledger adapter (see bridges/ for the parallel-file pattern).
  const ledgerBridge = createClassyticLedgerBridge();

  engine = createInvoiceEngine({
    mongoose: mongoose.connection,
    scope: { strategy: 'field', tenantField: 'organizationId', required: false },
    currency: 'BDT',
    // Roll forward stale index options on boot. Mongoose's default
    // `Model.init()` only adds missing indexes; this picks up changes to
    // `partialFilterExpression`, `unique`, `sparse` etc. on indexes that
    // were created by an earlier schema version. PACKAGE_RULES §32.
    syncIndexes: true,
    ledger: ledgerBridge,
    // Catalog bridge — enriches invoice lines from productId (name, skuRef, hsCode, uom).
    // Lines that already carry description + unitPrice are unaffected.
    catalog: createCatalogBridgeForInvoice(),
    // PDF bridge — pdfmake-backed Mushak 6.3-style renderer (server-side).
    // Required for email attachments, customer portal download, NBR archive.
    pdf: createPdfBridge(),
    // Notification bridge — sends invoice emails via @classytic/notifications
    notification: config.invoice.notifications ? createNotificationBridge() : undefined,
    // Partner bridge — engine resolves customer/supplier contact info for the
    // notification layer so the NotificationBridge above stays a thin sender.
    partner: config.invoice.notifications ? createPartnerBridge() : undefined,
    // Arc's EventTransport drops straight in — byte-for-byte shape match
    // with `@classytic/arc/events`, so no adapter is needed.
    eventTransport,
    // Transactional outbox: every domain event the InvoiceRepository emits
    // is persisted to the MongoOutboxStore in the SAME MongoDB session as
    // the invoice write (PACKAGE_RULES §P8). The cron relay in src/cron/
    // picks up pending events and publishes them to Arc's transport.
    outbox: outboxStore,
    numbering: {
      out_invoice: { prefix: 'INV', partition: 'yearly', padding: 5 },
      in_invoice: { prefix: 'BILL', partition: 'yearly', padding: 5 },
      out_refund: { prefix: 'CN', partition: 'yearly', padding: 4 },
      in_refund: { prefix: 'VCN', partition: 'yearly', padding: 4 },
      receipt: { prefix: 'RCT', partition: 'monthly', padding: 4 },
    },
    dunning: {
      schedule: config.invoice.dunningSchedule,
      gracePeriodDays: config.invoice.dunningGraceDays,
    },
    // Approval workflow — opt-in via INVOICE_APPROVAL env
    approval: config.invoice.approvalEnabled
      ? {
          enabled: true,
          autoApproveBelow: config.invoice.approvalAutoApproveBelow,
        }
      : undefined,
    // Late fee auto-calculation — opt-in via INVOICE_LATE_FEE env
    lateFee: config.invoice.lateFeeEnabled
      ? {
          rate: config.invoice.lateFeeRate,
          period: config.invoice.lateFeePeriod,
          maxFee: config.invoice.lateFeeMaxFee,
          graceDays: config.invoice.lateFeeGraceDays,
        }
      : undefined,
    idempotency: true,
    silent: config.isProduction,
  });

  return engine;
}

export function invoice(): InvoiceEngine {
  if (!engine) throw new Error('Invoice engine not initialized');
  return engine;
}

export function getInvoiceEngineOrNull(): InvoiceEngine | null {
  return engine;
}
