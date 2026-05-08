/**
 * Invoice Handlers — custom routes not covered by Arc's auto-CRUD or actions.
 *
 * Mutation handlers validate with Zod schemas from @classytic/invoice/schemas.
 * Read handlers use mongokit's QueryParser-driven APIs.
 */

import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { NotFoundError } from '@classytic/arc/utils';
import type { PaymentTerm } from '@classytic/invoice';
import { createPaymentTermSchema, createRecurringSchema, invoiceCreateSchema } from '@classytic/invoice/schemas';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import { invoice } from './invoice-engine.js';

type Req = RequestWithExtras;

// `query.branchId` fallback keeps cross-branch admin lookups working —
// Arc's `getOrgId` returns the active branch from auth scope; the query
// param is only honored when scope is missing (admin tools / scripts).
function ctx(req: Req) {
  const user = req.user as { id?: string; _id?: string } | undefined;
  return {
    organizationId: getOrgId(req.scope) ?? (req.query as { branchId?: string } | undefined)?.branchId,
    actorId: getUserId(req.scope) ?? user?.id ?? user?._id,
  };
}

// ── Aging Report ──────────────────────────────────────────────────────────────

export async function getAgingReport(req: Req) {
  const { side, asOfDate, partnerId } = req.query as Record<string, string>;
  const data = await invoice().services.aging.agingReport(ctx(req), {
    side: (side as 'receivable' | 'payable') ?? 'receivable',
    asOfDate: asOfDate ? new Date(asOfDate) : undefined,
    partnerId,
  });
  return data;
}

// ── Receipt (POS shortcut) ────────────────────────────────────────────────────

export async function createReceipt(req: Req) {
  // POS receipt shortcut: default `moveType: 'receipt'` so callers don't
  // have to know the discriminator. Explicitly-set values still win.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = invoiceCreateSchema.parse({ moveType: 'receipt', ...body });
  const data = await invoice().repositories.invoices.createReceipt(parsed as any, ctx(req));
  return data;
}

// ── Overdue ───────────────────────────────────────────────────────────────────

export async function getOverdueInvoices(req: Req) {
  const c = ctx(req);
  const data = await invoice().repositories.invoices.getOverdue(new Date(), {
    organizationId: c.organizationId,
  });
  return data;
}

// ── Dunning ───────────────────────────────────────────────────────────────────

export async function processDunning(req: Req) {
  const wf = (req.server as any).getWorkflow?.('invoice-dunning');
  if (wf) {
    const run = await wf.start(ctx(req));
    return { runId: run._id, status: run.status };
  }
  const result = await invoice().services.dunning.processDunning(ctx(req));
  return result;
}

// ── Recurring ─────────────────────────────────────────────────────────────────

export async function listRecurring(req: Req): Promise<unknown> {
  const c = ctx(req);
  const data = await invoice().repositories.recurringInvoices.getAll(
    { filters: { active: true } },
    { organizationId: c.organizationId },
  );
  return data;
}

export async function createRecurring(req: Req) {
  const parsed = createRecurringSchema.parse(req.body);
  const data = await invoice().services.recurring.create(parsed as any, ctx(req));
  return data;
}

export async function processRecurring(req: Req) {
  const wf = (req.server as any).getWorkflow?.('invoice-recurring');
  if (wf) {
    const run = await wf.start(ctx(req));
    return { runId: run._id, status: run.status };
  }
  const result = await invoice().services.recurring.processScheduled(ctx(req));
  return result;
}

// ── Document Data (for PDF/print) ─────────────────────────────────────────────

export async function getDocumentData(req: Req) {
  const { id } = req.params as { id: string };
  const c = ctx(req);
  const inv = await invoice().repositories.invoices.getById(id, {
    organizationId: c.organizationId,
  });
  if (!inv) throw new NotFoundError(`Invoice '${id}' not found`);
  const { toDocumentData } = await import('@classytic/invoice');
  const data = toDocumentData(inv);
  return data;
}

// ── Server-side PDF (Mushak 6.3 layout) ──────────────────────────────────────
//
// Standard ERP feature — Odoo / ERPNext / Saleor all generate invoice PDFs
// server-side. Required for email attachments, customer portal download,
// and NBR audit archival. Bridge wired in invoice-engine.ts (pdfmake).

export async function downloadPdf(req: Req, reply: import('fastify').FastifyReply) {
  const { id } = req.params as { id: string };
  const result = await invoice().record.generatePDF(id, ctx(req));
  reply
    .header('content-type', result.mimeType ?? 'application/pdf')
    .header('content-disposition', `inline; filename="${result.filename ?? `invoice-${id}.pdf`}"`)
    .send(result.buffer);
}

// ── Batch Operations ─────────────────────────────────────────────────────────

export async function batchCreate(req: Req) {
  const body = req.body as { invoices: unknown[] };
  const data = await invoice().services.batch.batchCreate(body.invoices as any[], ctx(req));
  return data;
}

export async function batchPost(req: Req) {
  const body = req.body as { ids: string[] };
  const data = await invoice().services.batch.batchPost(body.ids, ctx(req));
  return data;
}

export async function batchRecordPayment(req: Req) {
  const body = req.body as { payments: unknown[] };
  const data = await invoice().services.batch.batchRecordPayment(body.payments as any[], ctx(req));
  return data;
}

export async function batchCancel(req: Req) {
  const body = req.body as { ids: string[]; reason: string };
  const data = await invoice().services.batch.batchCancel(body.ids, body.reason ?? 'batch cancel', ctx(req));
  return data;
}

// ── Payment Terms ────────────────────────────────────────────────────────────

export async function listPaymentTerms(req: Req): Promise<unknown> {
  const c = ctx(req);
  // `mode: 'offset'` narrows to OffsetPaginationResult — Arc 2.13 emits the
  // shape directly with no envelope.
  const raw = await invoice().repositories.paymentTerms.getAll(
    { filters: { active: true }, mode: 'offset' },
    { organizationId: c.organizationId },
  );
  const result = raw as OffsetPaginationResult<PaymentTerm>;
  return { ...result };
}

export async function createPaymentTerm(req: Req) {
  const parsed = createPaymentTermSchema.parse(req.body);
  const data = await invoice().services.paymentTerm.create(parsed as any, ctx(req));
  return data;
}

export async function getPaymentTerm(req: Req) {
  const { id } = req.params as { id: string };
  const c = ctx(req);
  const data = await invoice().repositories.paymentTerms.getById(id, {
    organizationId: c.organizationId,
  });
  return data;
}

export async function computeInstallmentSchedule(req: Req) {
  const { id } = req.params as { id: string };
  const body = req.body as { invoiceDate: string; totalAmount: number };
  const c = ctx(req);
  const term = await invoice().repositories.paymentTerms.getById(id, {
    organizationId: c.organizationId,
  });
  if (!term) throw new NotFoundError(`PaymentTerm '${id}' not found`);
  const data = invoice().services.paymentTerm.computeSchedule(term, new Date(body.invoiceDate), body.totalAmount);
  return data;
}
