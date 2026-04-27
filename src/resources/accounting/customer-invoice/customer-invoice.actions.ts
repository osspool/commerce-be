/**
 * Customer Invoice Action Registry — Stripe-style state transitions (A/R)
 *
 * Wired via declarative `actions:` block → POST /accounting/customer-invoices/:id/action
 * Body: { action: "post" | "receive" | "debit-note", ... }
 *
 *   - `post`        id = Order._id    → A/R invoice JE (credit-limit gate)
 *   - `receive`     id = invoice JE   → cash receipt + match
 *   - `debit-note`  id = invoice JE   → allowance / return + match
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { Account, accounting, JournalEntry } from '../accounting.engine.js';
import { customerDebitNoteToPosting, validateNoteInput } from '../posting/contracts/credit-debit-note.contract.js';
import { customerInvoiceToPosting, customerReceiptToPosting } from '../posting/contracts/customer-invoice.contract.js';
import { type BillGroupKey, computeOpenBalance, maybeSettleGroup } from '../posting/open-balance.service.js';
import { createPosting, SYSTEM_ACTOR_ID } from '../posting/posting.service.js';

function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? SYSTEM_ACTOR_ID) as string;
  return { orgId, actorId };
}

async function arAccountId(): Promise<mongoose.Types.ObjectId> {
  const acc = await Account.findOne({ accountTypeCode: '1141' }).select('_id').lean();
  if (!acc) {
    throw Object.assign(new Error('A/R control account 1141 not seeded'), {
      statusCode: 503,
      code: 'CHART_NOT_SEEDED',
    });
  }
  return acc._id as mongoose.Types.ObjectId;
}

interface InvoiceContext {
  orderId: string;
  customerId: string;
  branchId?: string;
  arId: mongoose.Types.ObjectId;
  groupKey: BillGroupKey;
}

async function loadInvoiceContext(invJeId: string): Promise<InvoiceContext> {
  const inv = await JournalEntry.findById(invJeId).lean();
  if (!inv) {
    throw Object.assign(new Error('Invoice not found'), {
      statusCode: 404,
      code: 'INVOICE_NOT_FOUND',
    });
  }
  const arId = await arAccountId();
  const items = inv.journalItems as Array<{
    account: mongoose.Types.ObjectId;
    partnerId?: string;
  }>;
  const arLine = items.find((i) => String(i.account) === String(arId));
  if (!arLine || !arLine.partnerId) {
    throw Object.assign(new Error('Not a customer invoice — missing partner-tagged A/R line'), {
      statusCode: 400,
      code: 'NOT_A_CUSTOMER_INVOICE',
    });
  }
  const sourceRef = (inv as { sourceRef?: { sourceId?: unknown } }).sourceRef;
  const orderId = sourceRef?.sourceId ? String(sourceRef.sourceId) : String(inv._id);
  const branchId = (inv as { organizationId?: unknown }).organizationId?.toString();
  return {
    orderId,
    customerId: arLine.partnerId,
    branchId,
    arId,
    groupKey: {
      controlAccountId: arId,
      partnerId: arLine.partnerId,
      sourceId: orderId,
      side: 'receivable',
    },
  };
}

function assertPositiveIntegerPaisa(amount: unknown): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('amount must be a positive integer (paisa)'), {
      statusCode: 400,
      code: 'INVALID_AMOUNT',
    });
  }
}

/**
 * Credit-limit gate (Phase 3d). Reads from the Customer model when
 * ENABLE_CREDIT_LIMIT is on. Returns ok=true to skip the gate, otherwise
 * the message to surface as a 400 from the action handler.
 */
async function enforceCreditLimit(
  customerId: string,
  newAmount: number,
  arId: mongoose.Types.ObjectId,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (process.env.ENABLE_CREDIT_LIMIT !== 'true') return { ok: true };
  const partner = await mongoose.connection
    .db!.collection('customers')
    .findOne({ _id: new mongoose.Types.ObjectId(customerId) });
  if (!partner || !partner.creditEnabled) return { ok: true };
  if (partner.creditLimit == null) return { ok: true };
  const limit = Number(partner.creditLimit);
  if (!Number.isFinite(limit) || limit < 0) return { ok: true };

  const openItems = (await accounting.repositories.reconciliations.getOpenItems({
    accountId: arId,
    filter: { partnerId: customerId },
  } as never)) as Array<{ debit?: number; credit?: number }>;
  const currentOutstanding = openItems.reduce((s, i) => s + ((i.debit || 0) - (i.credit || 0)), 0);
  const projected = currentOutstanding + newAmount;
  if (projected > limit) {
    return {
      ok: false,
      message: `credit limit exceeded: outstanding ${currentOutstanding} + new ${newAmount} > limit ${limit}`,
    };
  }
  return { ok: true };
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** id = Order._id. Posts the credit-sale invoice JE. */
async function postInvoiceAction(orderId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const order = await mongoose.connection
    .db!.collection('orders')
    .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
  if (!order) {
    throw Object.assign(new Error('Order not found'), {
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    });
  }
  const customerId = (data.customerId as string | undefined) || (order.customer ? String(order.customer) : undefined);
  if (!customerId) {
    throw Object.assign(new Error('customerId is required'), {
      statusCode: 400,
      code: 'NO_CUSTOMER',
    });
  }
  const amount = (data.amount as number | undefined) ?? Number(order.total || order.grandTotal || 0);
  if (!amount || amount <= 0) {
    throw Object.assign(new Error('amount (paisa) is required'), {
      statusCode: 400,
      code: 'INVALID_AMOUNT',
    });
  }

  // Credit-limit gate BEFORE posting (fail fast — never leave a partial JE).
  const arId = await arAccountId();
  const gate = await enforceCreditLimit(customerId, amount, arId);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), {
      statusCode: 400,
      code: 'CREDIT_LIMIT_EXCEEDED',
    });
  }

  const posting = customerInvoiceToPosting({
    orderId: String(order._id),
    customerId,
    totalAmount: amount,
    issuedAt: new Date((order.createdAt as Date) || new Date()),
    dueDate: data.dueDate ? new Date(data.dueDate as string) : undefined,
    creditDays: data.creditDays as number | undefined,
    invoiceNumber: (data.invoiceNumber as string | undefined) || (order.orderNumber as string | undefined),
  });
  const branchId = (order.branch && String(order.branch)) || orgId;
  return createPosting(branchId, { ...posting, actorId });
}

/** id = invoice JE _id. Records a receipt + atomically settles if net=0. */
async function receiveAction(invJeId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const ctx = await loadInvoiceContext(invJeId);

  assertPositiveIntegerPaisa(data.amount);
  const amount = data.amount as number;

  const open = await computeOpenBalance(ctx.groupKey);
  if (amount > open) {
    throw Object.assign(new Error(`amount ${amount} exceeds open balance ${open}`), {
      statusCode: 400,
      code: 'AMOUNT_EXCEEDS_OPEN_BALANCE',
    });
  }

  const posting = customerReceiptToPosting({
    orderId: ctx.orderId,
    customerId: ctx.customerId,
    amount,
    date: data.date ? new Date(data.date as string) : new Date(),
    toAccountCode: data.toAccountCode as string | undefined,
    reference: data.reference as string | undefined,
  });
  const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
  const settled = await maybeSettleGroup(ctx.groupKey);
  return { ...result, settled };
}

/** id = invoice JE _id. Posts a customer debit note (allowance / return). */
async function debitNoteAction(invJeId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const ctx = await loadInvoiceContext(invJeId);

  validateNoteInput({
    amount: data.amount as number,
    reason: data.reason as string,
    reference: data.reference as string,
  });

  const idempotencyKey = `customer-debit-note-${ctx.orderId}-${data.reference}-${data.amount}`;
  const existing = await JournalEntry.findOne({ idempotencyKey }).select('_id state').lean();
  if (existing) {
    return {
      journalEntryId: (existing._id as mongoose.Types.ObjectId).toString(),
      state: (existing as { state: string }).state,
      matched: false,
      idempotent: true,
    };
  }

  const open = await computeOpenBalance(ctx.groupKey);
  if ((data.amount as number) > open) {
    throw Object.assign(new Error(`debit note amount ${data.amount} exceeds open balance ${open}`), {
      statusCode: 400,
      code: 'AMOUNT_EXCEEDS_OPEN_BALANCE',
    });
  }

  const posting = customerDebitNoteToPosting({
    sourceId: ctx.orderId,
    sourceModel: 'Order',
    customerId: ctx.customerId,
    amount: data.amount as number,
    reason: data.reason as string,
    reference: data.reference as string,
    date: data.date ? new Date(data.date as string) : undefined,
  });
  const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
  const matched = await maybeSettleGroup(ctx.groupKey);
  return { ...result, matched };
}

// ─── Config ─────────────────────────────────────────────────────────────────

const arFinanceRoles = requireRoles('admin', 'finance_admin');

/**
 * Arc 2.8 declarative actions — imported by customer-invoice.resource.ts.
 * All actions use arFinanceRoles via actionPermissions fallback.
 */
// Arc 2.9's legacy field-map schema treated every field as required. Use
// full JSON Schema shape so arc's normalizer honours our explicit `required`
// array instead of auto-requiring every field.
export const customerInvoiceActions = {
  post: {
    handler: postInvoiceAction,
    schema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Customer _id (default from order.customer)' },
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa (default order.grandTotal)' },
        creditDays: { type: 'integer', minimum: 0, description: 'Net N days' },
        dueDate: { type: 'string', format: 'date' },
        invoiceNumber: { type: 'string' },
      },
      required: [],
    },
  },
  receive: {
    handler: receiveAction,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa' },
        toAccountCode: { type: 'string', description: 'Cash/bank account code (default 1112)' },
        reference: { type: 'string' },
        date: { type: 'string', format: 'date' },
      },
      required: ['amount'],
    },
  },
  'debit-note': {
    handler: debitNoteAction,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa' },
        reason: { type: 'string', minLength: 3, description: 'Audit reason (min 3 chars)' },
        reference: { type: 'string', minLength: 1, description: 'DN number for idempotency' },
        date: { type: 'string', format: 'date' },
      },
      required: ['amount', 'reason', 'reference'],
    },
  },
};

export { arFinanceRoles as customerInvoiceActionPermissions };
