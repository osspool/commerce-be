/**
 * Invoice Action Registry — Stripe-style state transitions
 *
 * Wired via declarative `actions:` block → POST /accounting/invoices/:id/action
 * Body: { action: "post" | "cancel" | "void" | "unpost" | "record_payment" |
 *         "credit_note_full" | "credit_note_partial" | "mark_sent" |
 *         "mark_viewed" | "clone", ... }
 *
 * All actions map 1:1 to domain verbs on InvoiceRepository (PACKAGE_RULES §30).
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { invoice } from './invoice-engine.js';

function ctx(req: RequestWithExtras) {
  return {
    organizationId: getOrgId(req.scope) ?? undefined,
    actorId: (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined) as string | undefined,
  };
}

const financeRoles = requireRoles('admin', 'finance_admin', 'finance_manager');

/**
 * Arc 2.8 declarative actions — imported by invoice.resource.ts.
 * All actions use financeRoles via actionPermissions fallback.
 * Only actions with schemas use the full ActionDefinition format.
 */
export const invoiceActions = {
  post: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.post(id, ctx(req));
  },

  cancel: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return invoice().repositories.invoices.cancel(id, (data.reason as string) ?? 'cancelled', ctx(req));
    },
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Cancellation reason' } },
      required: [],
    },
  },

  void: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return invoice().repositories.invoices.void(id, (data.reason as string) ?? 'voided', ctx(req));
    },
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Void reason' } },
      required: [],
    },
  },

  unpost: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.unpost(id, ctx(req));
  },

  record_payment: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return invoice().repositories.invoices.recordPayment(
        {
          invoiceId: id,
          paymentId: data.paymentId as string,
          amount: data.amount as number,
          method: data.method as string,
          currency: data.currency as string | undefined,
          date: data.date ? new Date(data.date as string) : undefined,
          discountAmount: data.discountAmount as number | undefined,
        },
        ctx(req),
      );
    },
    schema: {
      type: 'object',
      properties: {
        paymentId: { type: 'string', description: 'External payment reference' },
        amount: { type: 'number', description: 'Payment amount (integer cents)' },
        method: { type: 'string', description: 'Payment method (cash, card, bank_transfer, etc.)' },
        discountAmount: { type: 'number', description: 'Early-payment discount (integer cents)' },
      },
      required: ['paymentId', 'amount', 'method'],
    },
  },

  credit_note_full: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.creditNoteFull(id, ctx(req));
  },

  credit_note_partial: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return invoice().repositories.invoices.creditNotePartial(id, data as any, ctx(req));
    },
    schema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sequence: { type: 'number' },
              quantity: { type: 'number' },
              amount: { type: 'number' },
            },
          },
        },
      },
      required: ['lines'],
    },
  },

  create_deposit_invoice: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.createDepositInvoice(id, ctx(req));
  },

  mark_sent: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.markSent(id, ctx(req));
  },

  send_email: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const inv = await invoice().repositories.invoices.markSent(id, ctx(req));
      const notification = invoice().config?.notification;
      if (notification) {
        const formatAmt = (paisa: number) => (paisa / 100).toFixed(2);
        await notification
          .send({
            event: 'invoice:sent',
            recipient: { id: inv.partnerId, name: inv.partnerName },
            data: {
              invoiceId: inv._id,
              invoiceNumber: inv.number ?? 'DRAFT',
              totalAmount: formatAmt(inv.totalAmount),
              amountDue: formatAmt(inv.amountDue),
              currency: inv.currency,
              invoiceDate: inv.date,
              dueDate: inv.dueDate ?? 'On receipt',
              moveType: inv.moveType,
              message: (data.message as string)
                ? `<p style="margin:16px 0;padding:12px;background:#f9fafb;border-radius:6px;">${data.message}</p>`
                : '',
            },
          })
          .catch(() => {}); // don't fail the action if email fails
      }
      return inv;
    },
    schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Optional message to include in email' } },
      required: [],
    },
  },

  mark_viewed: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.markViewed(id, ctx(req));
  },

  clone: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.clone(id, data as any, ctx(req));
  },

  submit_for_approval: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.submit(id, ctx(req));
  },

  approve: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
    return invoice().repositories.invoices.approve(id, ctx(req));
  },

  reject: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      return invoice().repositories.invoices.reject(id, (data.reason as string) ?? 'rejected', ctx(req));
    },
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Rejection reason' } },
      required: [],
    },
  },

  // Quote lifecycle lives in @classytic/order's QuotationRepository, not here.
  // The invoice package is a pure finance primitive (post/pay/age/reconcile).
  // Exposed at /quotations via quotation.resource.ts; see packages/order/src/repositories/quotation.repository.ts.
};
