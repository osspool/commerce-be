import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import { getPurchaseEngine } from '#resources/inventory/_engines/purchase.engine.js';
import { applyRatioBdt, normalizeNumber } from '../purchase-order.utils.js';
import type { PaymentData, TaxDetails } from './shared.js';
import { getSupplierById } from './shared.js';
import { withPurchaseTransaction } from './with-purchase-order-transaction.js';

/**
 * Pay a purchase order.
 *
 * Uses the package's `purchaseOrderRepository.pay()` domain verb (the
 * atomic-aggregation-pipeline path shipped in `@classytic/purchase` 0.1.2)
 * instead of the lower-level `recordPayment` $set helper. Two consequences:
 *
 *   1. **Concurrency-safe.** Two simultaneous partial payments compose
 *      correctly via Mongo's `$add` against `$paidAmount` — the lost-
 *      increment race the old read-then-$set path exposed is closed.
 *   2. **FSM-protected.** The package's filter pins
 *      `status: $in [draft, approved, received]` so a cancelled PO
 *      cannot accept a payment even under concurrent flips.
 *
 * Be-prod still owns the supplier lookup, tax pro-rating, accounting
 * Transaction record (revenue side), and the cap-by-dueAmount UX guard —
 * those are not domain concerns of the kernel package.
 *
 * Both writes (Transaction + PO atomic CAS) run inside one
 * `withPurchaseTransaction(session)` so any failure aborts the whole
 * unit; no orphan Transactions, no PO drift.
 */
export async function payPurchase(
  purchaseId: string,
  paymentData: PaymentData = {},
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<unknown> {
  return withPurchaseTransaction(async (session) => {
    const PurchaseOrder = getPurchaseEngine().models.PurchaseOrder;
    const purchase = session
      ? await PurchaseOrder.findById(purchaseId).session(session)
      : await PurchaseOrder.findById(purchaseId);
    if (!purchase) throw createStatusError('Purchase not found', 404);
    // Friendly error before the CAS — the package's filter would also reject
    // a cancelled PO, but we want a precise message at this layer.
    assertState('pay', purchase.status, createStatusError, 'Cancelled purchases cannot be paid');

    const amount = normalizeNumber(paymentData.amount, purchase.dueAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createStatusError('Payment amount must be greater than zero');
    }
    // Cap guard — prevents overpaying. Read against the snapshot; if a
    // concurrent payment lands between this check and the atomic CAS, the
    // CAS still composes correctly (no lost increment), and a small
    // overshoot only matters as a UX accuracy issue, not a correctness one.
    if (amount > purchase.dueAmount) {
      throw createStatusError('Payment amount exceeds due amount');
    }

    const supplier = await getSupplierById(purchase.supplier ? String(purchase.supplier) : undefined);

    // Pro-rate VAT for partial payments — needed for the BD compliance
    // ledger (input-VAT recognition follows payment, not invoice, for
    // cash-method suppliers). taxDetails attaches the dominant rate so
    // accounting can pick the right input-VAT sub-account.
    const purchaseTaxTotal = normalizeNumber(purchase.taxTotal, 0);
    let paymentTax = 0;
    let taxDetails: TaxDetails | undefined;

    if (purchaseTaxTotal > 0 && purchase.grandTotal > 0) {
      const paymentRatio = amount / purchase.grandTotal;
      paymentTax = applyRatioBdt(purchaseTaxTotal, paymentRatio);

      const dominantRate = purchase.items.reduce((max: number, item) => {
        return (item.taxRate || 0) > max ? item.taxRate || 0 : max;
      }, 0);

      if (dominantRate > 0) {
        taxDetails = {
          type: 'vat',
          rate: dominantRate / 100,
          isInclusive: false,
          jurisdiction: 'BD',
        };
      }
    }

    // 1. Create the verified expense Transaction (revenue side) FIRST so
    //    we have an _id to push onto the PO's transactionIds[]. Inside
    //    the same session — if the PO CAS later fails, the session
    //    aborts and this Transaction rolls back.
    const transaction = await createVerifiedOperationalExpenseTransaction({
      amountBdt: amount,
      category: 'inventory_purchase',
      method: paymentData.method || 'cash',
      paymentDetails: {
        trxId: paymentData.reference,
        accountNumber: paymentData.accountNumber,
        walletNumber: paymentData.walletNumber,
        bankName: paymentData.bankName,
        accountName: paymentData.accountName,
        proofUrl: paymentData.proofUrl,
      },
      sourceModel: 'PurchaseOrder',
      sourceId: String(purchase._id),
      branchId: String(purchase.branch),
      source: 'api',
      metadata: {
        invoiceNumber: purchase.invoiceNumber,
        supplierId: supplier?._id?.toString?.() || null,
        supplierName: supplier?.name || null,
        purchaseTaxTotal: purchaseTaxTotal || null,
        paymentTax: paymentTax || null,
      },
      notes: [
        `Purchase payment: ${purchase.invoiceNumber}`,
        supplier?.name ? `Supplier: ${supplier.name}` : null,
        paymentData.notes,
      ]
        .filter(Boolean)
        .join('. '),
      verifiedBy: actorId,
      date: paymentData.transactionDate ? new Date(paymentData.transactionDate) : new Date(),
      taxBdt: paymentTax,
      taxDetails,
      session,
    });

    // 2. Atomic CAS via the package's `pay()` — increments `$paidAmount`,
    //    recomputes `dueAmount` + `paymentStatus` from the post-increment
    //    value, and pushes the transactionId onto `transactionIds[]` in
    //    a single round-trip. Concurrency-safe by construction.
    return getPurchaseEngine().repositories.purchaseOrder.pay(
      purchaseId,
      {
        amount,
        transactionId: String(transaction._id),
        ...(paymentData.method ? { method: paymentData.method } : {}),
      },
      {
        ...(actorId ? { actorId } : {}),
        ...(session ? { session } : {}),
      },
    );
  });
}
