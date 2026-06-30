import mongoose from 'mongoose';
import config from '#config/index.js';
import { majorToMinor } from '#shared/money.js';
import { vendorBillToPosting } from '../../posting/contracts/vendor-bill.contract.js';
import { definePostingHandler } from '../define-posting-handler.js';
import { PurchaseReceivedEvent, purchaseReceivedSchema } from '../event-definitions.js';

/**
 * Phase 1 A/P — vendor bill accrual.
 *
 * Posts the bill on `2111 A/P` tagged with `partnerId` at RECEIPT, not
 * at payment. Payment is a second JE matched to the bill line via
 * `reconciliations.match()` — see `/accounting/vendor-bills/:billJeId/pay`.
 *
 * Tax extraction prefers explicit `taxTotal`; falls back to per-item
 * `taxAmount` summation for legacy purchase docs. The dominant `vatRate`
 * is inferred from the most common item rate — per-line splitting is a
 * future enhancement.
 */
export const purchaseReceivedHandler = definePostingHandler({
  event: PurchaseReceivedEvent,
  payloadSchema: purchaseReceivedSchema,

  async build(payload, log) {
    // Mutual exclusion (single source of truth for A/P). When auto-invoicing
    // vendor bills is enabled, the @classytic/invoice engine creates AND posts
    // the bill (Cr A/P) from this SAME `purchase:received` event — see
    // invoice.events.ts. This direct accrual MUST yield, or A/P is credited
    // twice for one purchase (the two paths use different idempotency keys, so
    // the posting-service dedup cannot catch it). The invoice engine is the
    // document of record whenever the host opts into auto-invoicing.
    if (config.invoice.autoPurchase !== 'off') {
      log.debug(
        { purchaseId: payload.purchaseId },
        'purchase-received: auto-invoice owns the vendor bill — skipping direct A/P accrual',
      );
      return null;
    }

    const purchase = await mongoose.connection.db
      ?.collection('purchase_orders')
      .findOne({ _id: new mongoose.Types.ObjectId(payload.purchaseId) });

    if (!purchase?.supplier) return null;

    const items = (purchase.items as Array<Record<string, unknown>>) ?? [];
    const taxFromItems = items.reduce((s, it) => s + Number(it.taxAmount ?? 0), 0);
    const tax = Number(purchase.taxTotal ?? taxFromItems ?? 0);
    const dominantTaxRate = items.find((it) => Number(it.taxRate ?? 0) > 0)?.taxRate as number | undefined;

    const branchId = (purchase.branch && String(purchase.branch)) || payload.organizationId || undefined;

    if (!branchId) {
      log.warn({ purchaseId: payload.purchaseId }, 'purchase:received has no branch — skipping accounting');
      return null;
    }

    // PO model persists totals as BDT-major numbers (e.g. `grandTotal: 5520` = ৳5,520);
    // the vendor-bill posting contract works in paisa (debit/credit are paisa per
    // posting.service.ts). Convert at the boundary so JE amounts match real money.
    const totalAmountPaisa = majorToMinor(Number(purchase.grandTotal ?? 0));
    const taxPaisa = majorToMinor(tax);

    // Receipt is the operational signal that the bill is real and the A/P
    // liability has accrued — the goods are physically in, the PO was already
    // approved through procurement. Pass `autoPost: true` to skip draft state:
    // there is nothing left to review at this point. (The contract's intrinsic
    // default is draft for ad-hoc / manual bill creation; this event-driven
    // accrual path is authoritative.)
    const posting = vendorBillToPosting(
      {
        purchaseId: String(purchase._id),
        supplierId: String(purchase.supplier),
        totalAmount: totalAmountPaisa,
        tax: taxPaisa,
        vatRate: dominantTaxRate,
        receivedAt: new Date((purchase.receivedAt as Date) ?? new Date()),
        dueDate: purchase.dueDate ? new Date(purchase.dueDate as Date) : undefined,
        creditDays: purchase.creditDays as number | undefined,
        billNumber: purchase.invoiceNumber as string | undefined,
      },
      { autoPost: true },
    );

    return {
      branchId,
      posting,
      logFields: { purchaseId: payload.purchaseId },
      successMessage: 'Vendor bill posted (accrual A/P)',
    };
  },
});
