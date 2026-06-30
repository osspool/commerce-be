/**
 * Customer Invoice Action Registry — Stripe-style state transitions (A/R)
 *
 * Wired via declarative `actions:` block → POST /accounting/customer-invoices/:id/action
 * Body: { action: "post" | "receive" | "debit-note", ... }
 *
 *   - `post`        id = Order._id    → A/R invoice JE (credit-limit gate)
 *   - `receive`     id = invoice JE   → cash receipt + match
 *   - `debit-note`  id = invoice JE   → allowance / return + match
 *
 * Shared `getIds`, `loadPartnerContext`, `controlAccountId` and amount
 * assertion live in `../posting/partner-posting.helper.ts` so A/R and A/P
 * stay in lockstep.
 */

import type { RequestWithExtras } from '@classytic/arc/types';
import { requireFinanceAdmin } from '#shared/permissions.js';
import { majorToMinor } from '#shared/money.js';
import mongoose from 'mongoose';
import { accounting, JournalEntry } from '../accounting.engine.js';
import {
  assertPositiveIntegerPaisa,
  controlAccountId,
  getIds,
  loadPartnerContext,
  type PartnerContext,
} from '../posting/partner-posting.helper.js';
import { customerDebitNoteToPosting, validateNoteInput } from '../posting/contracts/credit-debit-note.contract.js';
import { customerInvoiceToPosting, customerReceiptToPosting } from '../posting/contracts/customer-invoice.contract.js';
import { computeOpenBalance, maybeSettleGroup } from '../posting/open-balance.service.js';
import { createPosting } from '../posting/posting.service.js';

const AR_ACCOUNT_CODE = '1141';

function loadInvoiceContext(invJeId: string): Promise<PartnerContext> {
  return loadPartnerContext({
    jeId: invJeId,
    side: 'receivable',
    controlCode: AR_ACCOUNT_CODE,
    docLabel: 'Invoice',
    notFoundCode: 'INVOICE_NOT_FOUND',
    notPartnerDocCode: 'NOT_A_CUSTOMER_INVOICE',
    notPartnerDocMessage: 'Not a customer invoice — missing partner-tagged A/R line',
  });
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
  const arId = await controlAccountId(AR_ACCOUNT_CODE);
  const gate = await enforceCreditLimit(customerId, amount, arId);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), {
      statusCode: 400,
      code: 'CREDIT_LIMIT_EXCEEDED',
    });
  }

  // VAT amount on the invoice — paisa, integer. Required to compute VDS split.
  // `data.vatAmount` wins; otherwise pull from order.taxAmount (if stored in
  // paisa) or order.taxTotal × 100 (if in major BDT).
  const vatFromOrder =
    typeof order.taxAmount === 'number'
      ? order.taxAmount
      : typeof order.taxTotal === 'number'
      ? majorToMinor(order.taxTotal)
      : 0;
  const vatAmount = (data.vatAmount as number | undefined) ?? vatFromOrder;

  // VDS lookup — customer's `vdsPayerCategory` (GOVT / BANK / NGO / TELECOM /
  // CORP) flags them as a designated VDS withholder under NBR rules. Any
  // non-null value enables the withholding split. `data.withholdVds` wins
  // for per-invoice override (e.g. exempt this single sale).
  let withholdVds = false;
  let vdsRate: number | undefined;
  try {
    const customer = await mongoose.connection
      .db!.collection('customers')
      .findOne(
        { _id: new mongoose.Types.ObjectId(customerId) },
        { projection: { vdsPayerCategory: 1, vdsRate: 1 } },
      );
    if (customer?.vdsPayerCategory) {
      withholdVds = true;
      vdsRate = customer.vdsRate as number | undefined;
    }
  } catch {
    // ignore — post without VDS split
  }
  if (typeof data.withholdVds === 'boolean') withholdVds = data.withholdVds;
  if (typeof data.vdsRate === 'number') vdsRate = data.vdsRate;

  // User-initiated `post` action → autoPost: true. Contract default is draft
  // (for automated/bulk issuance); explicit click posts.
  const posting = customerInvoiceToPosting(
    {
      orderId: String(order._id),
      customerId,
      totalAmount: amount,
      issuedAt: new Date((order.createdAt as Date) || new Date()),
      dueDate: data.dueDate ? new Date(data.dueDate as string) : undefined,
      creditDays: data.creditDays as number | undefined,
      invoiceNumber:
        (data.invoiceNumber as string | undefined) || (order.orderNumber as string | undefined),
      ...(vatAmount > 0 ? { vatAmount } : {}),
      withholdVds,
      ...(vdsRate !== undefined ? { vdsRate } : {}),
    },
    { autoPost: true },
  );
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
    orderId: ctx.sourceId,
    customerId: ctx.partnerId,
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

  const idempotencyKey = `customer-debit-note-${ctx.sourceId}-${data.reference}-${data.amount}`;
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

  // User-initiated debit-note action → autoPost: true. Contract default is
  // draft (for automated/bulk corrections); explicit click posts.
  const posting = customerDebitNoteToPosting(
    {
      sourceId: ctx.sourceId,
      sourceModel: 'Order',
      customerId: ctx.partnerId,
      amount: data.amount as number,
      reason: data.reason as string,
      reference: data.reference as string,
      date: data.date ? new Date(data.date as string) : undefined,
      // Optional GL override — route a service/allowance debit to its proper
      // account instead of the default Sales Returns (4114).
      contraAccount: (data.contraAccount as string | undefined) ?? undefined,
    },
    { autoPost: true },
  );
  const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
  const matched = await maybeSettleGroup(ctx.groupKey);
  return { ...result, matched };
}

// ─── Config ─────────────────────────────────────────────────────────────────

const arFinanceRoles = requireFinanceAdmin();

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
        vatAmount: {
          type: 'integer',
          minimum: 0,
          description: 'VAT portion in paisa. Required for VDS computation; defaults to order.taxAmount/taxTotal.',
        },
        withholdVds: {
          type: 'boolean',
          description: 'Override customer.vdsPayerCategory for this invoice. true = withhold, false = exempt this single sale.',
        },
        vdsRate: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Override VDS rate (0–1). Defaults to NBR standard 0.5.',
        },
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
        toAccountCode: { type: 'string', description: 'Cash/bank account code (defaults to BD.cash, the Cash at Bank current account)' },
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
