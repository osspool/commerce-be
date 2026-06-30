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
 *
 * Shared `getIds`, `loadPartnerContext`, and amount assertion live in
 * `../posting/partner-posting.helper.ts` so A/P stays in lockstep with A/R.
 */

import { calculateVDS } from '@classytic/bd-tax';
import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { requireFinanceAdmin } from '#shared/permissions.js';
import { majorToMinor } from '#shared/money.js';
import { JournalEntry } from '../accounting.engine.js';
import WithholdingCertificate from '../withholding/withholding-certificate.model.js';
import { buildCertificateData } from '../withholding/withholding-certificate.auto.js';
import {
  assertPositiveIntegerPaisa,
  getIds,
  loadPartnerContext,
  type PartnerContext,
} from '../posting/partner-posting.helper.js';
import { validateNoteInput, vendorCreditNoteToPosting } from '../posting/contracts/credit-debit-note.contract.js';
import { vendorBillToPosting, vendorPaymentToPosting } from '../posting/contracts/vendor-bill.contract.js';
import { computeOpenBalance, maybeSettleGroup } from '../posting/open-balance.service.js';
import { createPosting } from '../posting/posting.service.js';

const AP_ACCOUNT_CODE = '2111';

function loadBillContext(billJeId: string): Promise<PartnerContext> {
  return loadPartnerContext({
    jeId: billJeId,
    side: 'payable',
    controlCode: AP_ACCOUNT_CODE,
    docLabel: 'Bill',
    notFoundCode: 'BILL_NOT_FOUND',
    notPartnerDocCode: 'NOT_A_VENDOR_BILL',
    notPartnerDocMessage: 'Not a vendor bill — missing partner-tagged A/P line',
  });
}

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * id = Purchase._id. Posts the accrual A/P bill JE for a received purchase.
 *
 * Optional `data` overrides for finance flexibility:
 *   - `withholdVds: boolean` — force-enable/disable VDS for this one bill,
 *     overriding the supplier's `withholdVds` flag (e.g. supplier is
 *     normally a VDS target but this particular bill is exempt).
 *   - `vdsRate: number` — override the rate (0–1) for this bill.
 *   - `vatRate: number` — override the VAT rate used for input-credit
 *     account selection (defaults to dominant rate from purchase items).
 */
async function postBillAction(purchaseId: string, data: Record<string, unknown>, req: RequestWithExtras) {
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

  // Purchase totals on the document are stored in major BDT (decimal). The
  // posting contract expects paisa (integer minor units). Convert here and
  // round to integer paisa to match the same contract used by the
  // procurement-received bridge.
  const grandTotalPaisa = majorToMinor(Number(purchase.grandTotal || 0));
  const taxTotalPaisa = majorToMinor(Number(purchase.taxTotal || 0));

  // Dominant VAT rate across line items (most BD bills are single-rate; the
  // dominant one wins for input-VAT account selection).
  const items = (purchase.items as Array<{ taxRate?: number }> | undefined) ?? [];
  const dominantVatRate =
    (data.vatRate as number | undefined) ??
    items.find((it) => Number(it.taxRate ?? 0) > 0)?.taxRate ??
    undefined;

  // VDS lookup — supplier flag is the default; per-bill override wins.
  // Lookup is non-fatal: if the supplier doc is unreadable we post without VDS.
  let withholdVds = false;
  let vdsRate: number | undefined;
  try {
    const supplier = await mongoose.connection
      .db!.collection('suppliers')
      .findOne(
        { _id: new mongoose.Types.ObjectId(String(purchase.supplier)) },
        { projection: { withholdVds: 1, vdsRate: 1 } },
      );
    withholdVds = !!supplier?.withholdVds;
    vdsRate = supplier?.vdsRate as number | undefined;
  } catch {
    // ignore — post without VDS split
  }
  if (typeof data.withholdVds === 'boolean') withholdVds = data.withholdVds;
  if (typeof data.vdsRate === 'number') vdsRate = data.vdsRate;

  // User-initiated `post` action → autoPost: true. The contract's intrinsic
  // `false` is for automated event flows (purchase-received) where finance
  // reviews before posting; this endpoint represents the reviewer's explicit
  // click to post.
  const posting = vendorBillToPosting(
    {
      purchaseId: String(purchase._id),
      supplierId: String(purchase.supplier),
      totalAmount: grandTotalPaisa,
      tax: taxTotalPaisa,
      ...(dominantVatRate !== undefined ? { vatRate: dominantVatRate } : {}),
      receivedAt: new Date(purchase.receivedAt as Date),
      dueDate: purchase.dueDate ? new Date(purchase.dueDate as Date) : undefined,
      creditDays: purchase.creditDays as number | undefined,
      billNumber: purchase.invoiceNumber as string | undefined,
      withholdVds,
      ...(vdsRate !== undefined ? { vdsRate } : {}),
    },
    { autoPost: true },
  );
  const branchId = String(purchase.branch || '') || orgId;
  const result = await createPosting(branchId, { ...posting, actorId });

  // Auto-generate a VDS certificate stub when withholding was applied.
  // Finance staff fills in challanNumber when they remit to NBR.
  if (withholdVds && taxTotalPaisa > 0) {
    const vdsCalc = calculateVDS(taxTotalPaisa, vdsRate ?? 0.5);
    if (vdsCalc.vdsAmount > 0) {
      let supplierTin: string | undefined;
      let supplierName: string | undefined;
      try {
        const sup = await mongoose.connection
          .db!.collection('suppliers')
          .findOne(
            { _id: new mongoose.Types.ObjectId(String(purchase.supplier)) },
            { projection: { bin: 1, tin: 1, name: 1 } },
          );
        supplierTin = (sup?.bin ?? sup?.tin) as string | undefined;
        supplierName = sup?.name as string | undefined;
      } catch {
        // non-fatal — cert will use UNKNOWN placeholders
      }
      const certData = buildCertificateData({
        organizationId: branchId ?? orgId ?? '',
        supplierId: String(purchase.supplier),
        purchaseId,
        journalEntryId: result.journalEntryId,
        grossAmount: taxTotalPaisa,
        vdsRate: vdsRate ?? 0.5,
        vdsAmount: vdsCalc.vdsAmount,
        date: new Date(),
        supplierTin,
        supplierName,
      });
      try {
        await WithholdingCertificate.create(certData);
      } catch {
        // Duplicate key on certificateNumber = idempotent replay; swallow.
      }
    }
  }

  return result;
}

/**
 * POST /accounting/vendor-bills/bulk-pay
 * Apply one payment across multiple open bills.
 *
 * Body: { allocations: [{ billJeId, amount }, ...], fromAccountCode?, reference?, date? } — amounts in paisa
 *
 * Per-allocation amount is asserted against THAT bill's open balance; the
 * full payment is rejected (all-or-nothing) if any line fails — the
 * accounting posting for each allocation is created in order, and a
 * Mongo session would ideally wrap them. We use sequential creates with
 * idempotent group settlement; on partial failure, the caller sees the
 * failed allocation index and can retry the remainder.
 */
export async function bulkPayHandler(
  req: RequestWithExtras & { body?: unknown },
  reply: { send: (x: unknown) => unknown },
): Promise<unknown> {
  const { orgId, actorId } = getIds(req);
  const body = (req.body ?? {}) as {
    allocations?: Array<{ billJeId: string; amount: number }>;
    fromAccountCode?: string;
    reference?: string;
    date?: string;
  };

  const allocations = body.allocations ?? [];
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw Object.assign(new Error('allocations array is required'), {
      statusCode: 400,
      code: 'ALLOCATIONS_REQUIRED',
    });
  }
  if (allocations.length > 50) {
    throw Object.assign(new Error('Cannot allocate to more than 50 bills in one call'), {
      statusCode: 400,
      code: 'TOO_MANY_ALLOCATIONS',
    });
  }

  // Pre-flight: load every bill context + validate amount against open balance
  // BEFORE creating any posting. Atomic-ish: if any fails, no postings created.
  const contexts: Array<{ ctx: PartnerContext; amount: number; billJeId: string }> = [];
  for (let i = 0; i < allocations.length; i++) {
    const { billJeId, amount } = allocations[i] ?? { billJeId: '', amount: 0 };
    if (!billJeId) {
      throw Object.assign(new Error(`allocations[${i}].billJeId required`), {
        statusCode: 400,
        code: 'ALLOCATION_INVALID',
      });
    }
    assertPositiveIntegerPaisa(amount);
    const ctx = await loadBillContext(billJeId);
    const open = await computeOpenBalance(ctx.groupKey);
    if (amount > open) {
      throw Object.assign(
        new Error(`allocations[${i}] amount ${amount} exceeds open balance ${open} for bill ${billJeId}`),
        { statusCode: 400, code: 'AMOUNT_EXCEEDS_OPEN_BALANCE', allocationIndex: i },
      );
    }
    contexts.push({ ctx, amount, billJeId });
  }

  const date = body.date ? new Date(body.date) : new Date();
  const results: Array<{ billJeId: string; journalEntryId: string; settled: boolean }> = [];

  for (const { ctx, amount, billJeId } of contexts) {
    const posting = vendorPaymentToPosting({
      purchaseId: ctx.sourceId,
      supplierId: ctx.partnerId,
      amount,
      date,
      fromAccountCode: body.fromAccountCode,
      reference: body.reference,
    });
    const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
    const settled = await maybeSettleGroup(ctx.groupKey);
    results.push({
      billJeId,
      journalEntryId: (result as { journalEntryId: string }).journalEntryId,
      settled,
    });
  }

  const totalPaid = contexts.reduce((s, c) => s + c.amount, 0);
  return reply.send({ allocations: results, totalPaid, billCount: results.length });
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
    purchaseId: ctx.sourceId,
    supplierId: ctx.partnerId,
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
  const idempotencyKey = `vendor-credit-note-${ctx.sourceId}-${data.reference}-${data.amount}`;
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

  // User-initiated credit-note action → autoPost: true. Contract default is
  // draft (for automated/bulk corrections); the explicit click posts.
  const posting = vendorCreditNoteToPosting(
    {
      sourceId: ctx.sourceId,
      sourceModel: 'PurchaseOrder',
      supplierId: ctx.partnerId,
      amount: data.amount as number,
      reason: data.reason as string,
      reference: data.reference as string,
      date: data.date ? new Date(data.date as string) : undefined,
      // Optional GL override — route a service/allowance credit to its proper
      // account instead of the default Purchase Returns (5503).
      contraAccount: (data.contraAccount as string | undefined) ?? undefined,
    },
    { autoPost: true },
  );
  const result = await createPosting(ctx.branchId || orgId, { ...posting, actorId });
  const matched = await maybeSettleGroup(ctx.groupKey);
  return { ...result, matched };
}

// ─── Config ─────────────────────────────────────────────────────────────────

const apFinanceRoles = requireFinanceAdmin();

/**
 * Arc 2.8 declarative actions — imported by vendor-bill.resource.ts.
 * All actions use apFinanceRoles via actionPermissions fallback.
 */
// Arc 2.9's legacy field-map schema treated every field as required. We use
// full JSON Schema shape here so arc's normalizer uses our explicit `required`
// array instead of auto-requiring every field.
export const vendorBillActions = {
  post: {
    handler: postBillAction,
    schema: {
      type: 'object',
      properties: {
        withholdVds: {
          type: 'boolean',
          description: 'Override supplier VDS flag for this bill. Use true to force-withhold VDS, false to skip VDS even when supplier is a withholding target.',
        },
        vdsRate: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Override VDS rate (0–1) for this bill. Defaults to supplier rate or NBR standard 0.5.',
        },
        vatRate: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Override the dominant VAT rate (%) used for input-credit account selection.',
        },
      },
      required: [],
    },
  },
  pay: {
    handler: payBillAction,
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount in paisa' },
        fromAccountCode: { type: 'string', description: 'Cash/bank account code (defaults to BD.cash, the Cash at Bank current account)' },
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
