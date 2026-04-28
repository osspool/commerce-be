import mongoose from 'mongoose';
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
    const totalAmountPaisa = Math.round(Number(purchase.grandTotal ?? 0) * 100);
    const taxPaisa = Math.round(tax * 100);

    const posting = vendorBillToPosting({
      purchaseId: String(purchase._id),
      supplierId: String(purchase.supplier),
      totalAmount: totalAmountPaisa,
      tax: taxPaisa,
      vatRate: dominantTaxRate,
      receivedAt: new Date((purchase.receivedAt as Date) ?? new Date()),
      dueDate: purchase.dueDate ? new Date(purchase.dueDate as Date) : undefined,
      creditDays: purchase.creditDays as number | undefined,
      billNumber: purchase.invoiceNumber as string | undefined,
    });

    return {
      branchId,
      posting,
      logFields: { purchaseId: payload.purchaseId },
      successMessage: 'Vendor bill posted (accrual A/P)',
    };
  },
});
