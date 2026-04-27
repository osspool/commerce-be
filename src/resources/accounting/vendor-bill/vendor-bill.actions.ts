/**
 * Vendor Bill Action Registry — Stripe-style state transitions (A/P)
 *
 * Wired via declarative `actions:` block → POST /accounting/vendor-bills/:id/action
 * Body: { action: "post" | "pay" | "credit-note", ... }
 *
 *   - `post`     id = Purchase._id        → accrual bill JE
 *   - `pay`      id = bill JE _id         → settlement payment + match
 *   - `credit-note` id = bill JE _id      → return / allowance + match
 *
 * Settlement model: bill, payments, and credit notes share
 * sourceRef.sourceId + partnerId. None are matched until the group's net
 * open balance hits zero, at which point maybeSettleGroup atomically
 * matches the whole group.
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { Account, JournalEntry } from '../accounting.engine.js';
import { validateNoteInput, vendorCreditNoteToPosting } from '../posting/contracts/credit-debit-note.contract.js';
import { vendorBillToPosting, vendorPaymentToPosting } from '../posting/contracts/vendor-bill.contract.js';
import { type BillGroupKey, computeOpenBalance, maybeSettleGroup } from '../posting/open-balance.service.js';
import { createPosting, SYSTEM_ACTOR_ID } from '../posting/posting.service.js';

function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? SYSTEM_ACTOR_ID) as string;
  return { orgId, actorId };
}

async function apAccountId(): Promise<mongoose.Types.ObjectId> {
  const acc = await Account.findOne({ accountTypeCode: '2111' }).select('_id').lean();
  if (!acc) {
    throw Object.assign(new Error('A/P control account 2111 not seeded'), {
      statusCode: 503,
      code: 'CHART_NOT_SEEDED',
    });
  }
  return acc._id as mongoose.Types.ObjectId;
}

interface BillContext {
  purchaseId: string;
  supplierId: string;
  branchId?: string;
  apId: mongoose.Types.ObjectId;
  groupKey: BillGroupKey;
}

async function loadBillContext(billJeId: string): Promise<BillContext> {
  const bill = await JournalEntry.findById(billJeId).lean();
  if (!bill) {
    throw Object.assign(new Error('Bill not found'), {
      statusCode: 404,
      code: 'BILL_NOT_FOUND',
    });
  }
  const apId = await apAccountId();
  const items = bill.journalItems as Array<{
    account: mongoose.Types.ObjectId;
    partnerId?: string;
  }>;
  const apLine = items.find((i) => String(i.account) === String(apId));
  if (!apLine || !apLine.partnerId) {
    throw Object.assign(new Error('Not a vendor bill — missing partner-tagged A/P line'), {
      statusCode: 400,
      code: 'NOT_A_VENDOR_BILL',
    });
  }
  const sourceRef = (bill as { sourceRef?: { sourceId?: unknown } }).sourceRef;
  const purchaseId = sourceRef?.sourceId ? String(sourceRef.sourceId) : String(bill._id);
  const branchId = (bill as { organizationId?: unknown }).organizationId?.toString();
  return {
    purchaseId,
    supplierId: apLine.partnerId,
    branchId,
    apId,
    groupKey: {
      controlAccountId: apId,
      partnerId: apLine.partnerId,
      sourceId: purchaseId,
      side: 'payable',
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

// ─── Actions ────────────────────────────────────────────────────────────────

/** id = Purchase._id. Posts the accrual A/P bill JE for a received purchase. */
async function postBillAction(purchaseId: string, _data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const purchase = await mongoose.connection
    .db!.collection('purchase_orders')
    .findOne({ _id: new mongoose.Types.ObjectId(purchaseId) });
  if (!purchase) {
    throw Object.assign(new Error('Purchase not found'), {
      statusCode: 404,
      code: 'PURCHASE_NOT_FOUND',
    });
  }
  if (!purchase.supplier) {
    throw Object.assign(new Error('Purchase has no supplier'), {
      statusCode: 400,
      code: 'PURCHASE_NO_SUPPLIER',
    });
  }
  if (!purchase.receivedAt) {
    throw Object.assign(new Error('Purchase not received yet — cannot post bill'), {
      statusCode: 400,
      code: 'PURCHASE_NOT_RECEIVED',
    });
  }

  const posting = vendorBillToPosting({
    purchaseId: String(purchase._id),
    supplierId: String(purchase.supplier),
    totalAmount: Number(purchase.grandTotal || 0),
    receivedAt: new Date(purchase.receivedAt as Date),
    dueDate: purchase.dueDate ? new Date(purchase.dueDate as Date) : undefined,
    creditDays: purchase.creditDays as number | undefined,
    billNumber: purchase.invoiceNumber as string | undefined,
  });
  const branchId = String(purchase.branch || '') || orgId;
  return createPosting(branchId, { ...posting, actorId });
}

/** id = bill JE _id. Records a payment + atomically settles if net=0. */
async function payBillAction(billJeId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const ctx = await loadBillContext(billJeId);

  assertPositiveIntegerPaisa(data.amount);
  const amount = data.amount as number;

  const open = await computeOpenBalance(ctx.groupKey);
  if (amount > open) {
    throw Object.assign(new Error(`amount ${amount} exceeds open balance ${open}`), {
      statusCode: 400,
      code: 'AMOUNT_EXCEEDS_OPEN_BALANCE',
    });
  }

  const posting = vendorPaymentToPosting({
    purchaseId: ctx.purchaseId,
    supplierId: ctx.supplierId,
    amount,
    date: data.date ? new Date(data.date as string) : new Date(),
    fromAccountCode: data.fromAccountCode as string | undefined,
    reference: data.reference as string | undefined,
  });
  const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
  const settled = await maybeSettleGroup(ctx.groupKey);
  return { ...result, settled };
}

/** id = bill JE _id. Posts a vendor credit note (return / allowance). */
async function creditNoteAction(billJeId: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = getIds(req);
  const ctx = await loadBillContext(billJeId);

  // Synchronous validation — fail fast on missing audit trail.
  validateNoteInput({
    amount: data.amount as number,
    reason: data.reason as string,
    reference: data.reference as string,
  });

  // Idempotency short-circuit — return the cached JE without re-checking
  // the open balance (which would over-count the not-yet-applied note).
  const idempotencyKey = `vendor-credit-note-${ctx.purchaseId}-${data.reference}-${data.amount}`;
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
    throw Object.assign(new Error(`credit note amount ${data.amount} exceeds open balance ${open}`), {
      statusCode: 400,
      code: 'AMOUNT_EXCEEDS_OPEN_BALANCE',
    });
  }

  const posting = vendorCreditNoteToPosting({
    sourceId: ctx.purchaseId,
    sourceModel: 'PurchaseOrder',
    supplierId: ctx.supplierId,
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

const apFinanceRoles = requireRoles('admin', 'finance_admin');

/**
 * Arc 2.8 declarative actions — imported by vendor-bill.resource.ts.
 * All actions use apFinanceRoles via actionPermissions fallback.
 */
// Arc 2.9's legacy field-map schema treated every field as required. We use
// full JSON Schema shape here so arc's normalizer uses our explicit `required`
// array instead of auto-requiring every field.
export const vendorBillActions = {
  post: postBillAction,
  pay: {
    handler: payBillAction,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa' },
        fromAccountCode: { type: 'string', description: 'Cash/bank account code (default 1112)' },
        reference: { type: 'string', description: 'Cheque number, transaction id' },
        date: { type: 'string', format: 'date', description: 'Payment date (default today)' },
      },
      required: ['amount'],
    },
  },
  'credit-note': {
    handler: creditNoteAction,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa' },
        reason: { type: 'string', minLength: 3, description: 'Audit reason (min 3 chars)' },
        reference: { type: 'string', minLength: 1, description: 'CN number for idempotency (CN-001)' },
        date: { type: 'string', format: 'date', description: 'CN date (default today)' },
      },
      required: ['amount', 'reason', 'reference'],
    },
  },
};

export { apFinanceRoles as vendorBillActionPermissions };
