/**
 * Invoice Action Registry — Stripe-style state transitions
 *
 * Wired via declarative `actions:` block → POST /accounting/invoices/:id/action
 * Body: { action: "submit_for_approval" | "decide" | "post" | "cancel" |
 *         "void" | "unpost" | "record_payment" | "credit_note_full" |
 *         "credit_note_partial" | "mark_sent" | "mark_viewed" | "clone" |
 *         "create_deposit_invoice" | "send_email", ... }
 *
 * Approval gate (`submit_for_approval` + `decide`) is contributed by the
 * shared `withApprovalChain` preset and replaces the legacy
 * `submit_for_approval` / `approve` / `reject` action shortcuts. The hooks
 * delegate to InvoiceRepository's `submit` / `approve` / `reject` so the
 * invoice's heavy side effects (status flips, numbering, ledger journal
 * entry on approve, domain events) are preserved end-to-end.
 *
 * Post-approval lifecycle verbs (post, cancel, void, …) map 1:1 to
 * InvoiceRepository methods — see PACKAGE_RULES §30.
 */

import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { requireFinanceManager } from '#shared/permissions.js';
import { minorToMajor } from '#shared/money.js';
import { resolveMethodKind } from '#shared/payments/method-kind.js';
import type { Invoice } from '@classytic/invoice';
import type { Repository } from '@classytic/mongokit';
import {
  withApprovalChain,
  type ApprovableDoc,
} from '#core/approval/with-approval-chain.js';
import logger from '#lib/utils/logger.js';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { invoice } from './invoice-engine.js';

function ctx(req: RequestWithExtras) {
  return {
    organizationId: getOrgId(req.scope) ?? undefined,
    actorId: (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined) as string | undefined,
  };
}

const financeRoles = requireFinanceManager();

// ─── Approval gate (submit_for_approval + decide) ──────────────────────────
//
// Replaces the legacy `submit_for_approval` / `approve` / `reject` shortcuts.
// The preset attaches / mutates the `ApprovalChain` value object on the
// invoice doc; the hooks below call into InvoiceRepository so existing side
// effects (status transitions, numbering, ledger posting on approve, domain
// events) keep firing.
/** Local view of `Invoice` that satisfies `ApprovableDoc` (P7). */
type InvoiceDoc = Invoice & ApprovableDoc;

const approvalActions = withApprovalChain<InvoiceDoc>({
  subjectType: 'invoice',
  // `invoice()` is safe to call here — `invoice.actions.ts` is dynamically
  // imported from `buildInvoiceResource()` AFTER `initializeInvoiceEngine()`
  // runs in `invoice.plugin.ts`.
  repository: invoice().repositories.invoices as unknown as Repository<InvoiceDoc>,
  // Only `draft` is a valid submit-from status — `assertTransition('submit')`
  // in the repo enforces the same. The preset additionally allows re-submit
  // when the prior chain is in `rejected` status (post-rejection retry); by
  // that point `repo.reject()` has already flipped the invoice back to draft.
  allowedSubmitStatus: ['draft'],
  // `status` is the default field; no `getStatus` override needed.
  permissions: {
    submit: financeRoles,
    decide: financeRoles,
  },
  toEvaluationContext: (doc) => ({
    branchId: String(doc.organizationId ?? ''),
    amount: Number(doc.totalAmount ?? 0),
    moveType: doc.moveType,
    currency: doc.currency,
  }),
  resolveChain: createPolicyChainResolver(),
  // Preset has already persisted the chain. `repo.submit` flips
  // `draft → pending_approval` and emits `invoice:approval.submitted`. We
  // omit the `{ chain }` option because the chain is already on the doc.
  onSubmitted: async (doc, c) => {
    return invoice().repositories.invoices.submit(String(doc._id), {
      organizationId: c.organizationId,
      ...(c.actorId !== null ? { actorId: c.actorId } : {}),
    });
  },
  // Chain just resolved to `approved`. `repo.approve` re-checks
  // `isApproved(chain)`, then transitions `pending_approval → draft → posted`
  // (numbering, FX freeze, ledger journal entry, `invoice:posted` event)
  // and emits `invoice:approval.approved`.
  onApproved: async (doc, c) => {
    return invoice().repositories.invoices.approve(String(doc._id), {
      organizationId: c.organizationId,
      ...(c.actorId !== null ? { actorId: c.actorId } : {}),
    });
  },
  // Chain just resolved to `rejected`. `repo.reject` flips
  // `pending_approval → draft` and emits `invoice:approval.rejected`. The
  // decision note becomes the human-readable rejection reason.
  onRejected: async (doc, decision, c) => {
    return invoice().repositories.invoices.reject(
      String(doc._id),
      decision.note ?? 'rejected',
      {
        organizationId: c.organizationId,
        ...(c.actorId !== null ? { actorId: c.actorId } : {}),
      },
    );
  },
});

/**
 * Arc 2.8 declarative actions — imported by invoice.resource.ts.
 * All actions use financeRoles via actionPermissions fallback.
 * Only actions with schemas use the full ActionDefinition format.
 */
export const invoiceActions = {
  // Approval gate — submit_for_approval + decide come from the shared preset
  ...approvalActions,

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
      const amount = data.amount as number;
      const currency = (data.currency as string | undefined) ?? 'BDT';
      const method = data.method as string | undefined;
      const date = data.date ? new Date(data.date as string) : undefined;
      return invoice().repositories.invoices.recordPayment(
        {
          invoiceId: id,
          payment: {
            externalId: data.paymentId as string | undefined,
            totalAmount: amount,
            currency,
            date,
            methodKind: resolveMethodKind(method),
            methodCode: method,
          },
          amount,
          currency,
          date,
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
        const formatAmt = (paisa: number) => minorToMajor(paisa).toFixed(2);
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
          .catch((err: unknown) => {
            // don't fail the action if email fails — but surface it so we
            // can debug delivery problems without losing the invoice send.
            logger.warn(
              { err, invoiceId: inv._id, invoiceNumber: inv.number },
              'invoice send_email: notification.send failed',
            );
          });
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

  // Quote lifecycle lives in @classytic/order's QuotationRepository, not here.
  // The invoice package is a pure finance primitive (post/pay/age/reconcile).
  // Exposed at /quotations via quotation.resource.ts; see packages/order/src/repositories/quotation.repository.ts.
};
