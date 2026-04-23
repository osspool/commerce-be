import { createStatusError } from '#resources/inventory/shared/status-errors.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import PurchaseOrder from '../models/purchase-order.model.js';
import purchaseOrderRepository from '../purchase-order.repository.js';
import { addBdt, applyRatioBdt, computePaymentStatus, normalizeNumber } from '../purchase-order.utils.js';
import type { PaymentData, TaxDetails } from './shared.js';
import { getSupplierById } from './shared.js';
import { withPurchaseTransaction } from './with-purchase-order-transaction.js';

export async function payPurchase(
  purchaseId: string,
  paymentData: PaymentData = {},
  actorId: string | undefined,
  assertState: (action: string, currentState: string, errorFactory: typeof createStatusError, message: string) => void,
): Promise<unknown> {
  return withPurchaseTransaction(async (session) => {
    const purchase = session
      ? await PurchaseOrder.findById(purchaseId).session(session)
      : await PurchaseOrder.findById(purchaseId);
    if (!purchase) throw createStatusError('Purchase not found', 404);
    assertState('pay', purchase.status, createStatusError, 'Cancelled purchases cannot be paid');

    const amount = normalizeNumber(paymentData.amount, purchase.dueAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createStatusError('Payment amount must be greater than zero');
    }
    if (amount > purchase.dueAmount) {
      throw createStatusError('Payment amount exceeds due amount');
    }

    const supplier = await getSupplierById(purchase.supplier ? String(purchase.supplier) : undefined);

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

    const paidAmount = addBdt(purchase.paidAmount, amount);
    const payment = computePaymentStatus(purchase.grandTotal, paidAmount);

    return purchaseOrderRepository.recordPayment(
      purchaseId,
      String(transaction._id),
      {
        paidAmount: payment.paidAmount,
        dueAmount: payment.dueAmount,
        paymentStatus: payment.paymentStatus,
        updatedBy: actorId,
      },
      { session },
    );
  });
}
