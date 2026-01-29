/**
 * POS Background Jobs
 *
 * Defines and registers background job handlers for POS operations.
 * Keeps job logic within the POS module for maintainability.
 *
 * Job Types:
 * - POS_CREATE_TRANSACTION: Create financial transaction after POS order
 *
 * @example Testing handler directly:
 * ```js
 * import { handleCreateTransaction } from './pos.jobs.js';
 * await handleCreateTransaction({ data: { orderId: '...', ... } });
 * ```
 */

import { registerModule } from '#modules/job/job.registry.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { toSmallestUnit } from '@classytic/revenue';
import Transaction from '#modules/transaction/transaction.model.js';
import orderRepository from '#modules/sales/orders/order.repository.js';
import logger from '#lib/utils/logger.js';

// ============================================
// JOB TYPE CONSTANTS
// ============================================

export const POS_JOB_TYPES = {
  CREATE_TRANSACTION: 'POS_CREATE_TRANSACTION',
};

// ============================================
// JOB HANDLERS (exported for testability)
// ============================================

/**
 * Create financial transaction for a POS order
 *
 * This handler is idempotent - uses order's idempotencyKey to prevent
 * duplicate transactions if job is retried.
 *
 * @param {Object} job - Job data from queue
 * @param {string} job.data.orderId - Order ID
 * @param {string} job.data.customerId - Customer ID or 'walk-in'
 * @param {number} job.data.totalAmount - Order total amount
 * @param {string} job.data.branchCode - Branch code
 * @param {string} job.data.cashierId - Cashier user ID
 * @param {string} job.data.paymentMethod - Payment method
 * @param {string} [job.data.paymentReference] - Payment reference/trxId
 * @param {Array} [job.data.paymentPayments] - Split payment details
 * @param {string} [job.data.vatInvoiceNumber] - VAT invoice number
 * @param {string} [job.data.vatSellerBin] - VAT seller BIN
 * @param {string} [job.data.terminalId] - POS terminal ID
 * @param {string} job.data.idempotencyKey - Idempotency key for transaction
 */
export async function handleCreateTransaction(job) {
  const {
    orderId,
    customerId,
    totalAmount,
    branchId,
    branchCode,
    cashierId,
    paymentMethod,
    paymentReference,
    paymentPayments,
    vatInvoiceNumber,
    vatSellerBin,
    // VAT data for transaction tax fields
    vatApplicable = false,
    vatAmount = 0,
    vatRate = 0,
    vatPricesIncludeVat = true,
    terminalId,
    idempotencyKey,
  } = job.data;

  logger.info({ jobId: job.jobId, orderId }, 'Processing POS transaction creation');

  const revenue = getRevenue();
  const amountInPaisa = toSmallestUnit(totalAmount, 'BDT');
  const isSplitPayment = paymentMethod === 'split';

  // Handle walk-in customers - don't pass invalid string to customerId
  const resolvedCustomerId = customerId && customerId !== 'walk-in' ? customerId : null;

  const { transaction } = await revenue.monetization.create({
    data: { customerId: resolvedCustomerId, sourceId: orderId, sourceModel: 'Order' },
    planKey: 'one_time',
    monetizationType: 'purchase',
    amount: amountInPaisa,
    currency: 'BDT',
    gateway: 'manual',
    paymentData: {
      method: paymentMethod,
      trxId: paymentReference,
      ...(paymentPayments && { payments: paymentPayments }),
    },
    metadata: {
      orderId: orderId.toString(),
      source: 'pos',
      branchCode,
      branchCode,
      terminalId,
      cashierId,
      vatInvoiceNumber,
      vatSellerBin,
      isSplitPayment,
    },
    idempotencyKey,
  });

  if (transaction) {
    // Build tax update for finance reporting
    const taxUpdate = {
      source: 'pos',
      branch: branchId,
      branchCode,
      // Populate tax fields from order VAT for cashflow reporting
      tax: vatApplicable ? toSmallestUnit(vatAmount, 'BDT') : 0,
      ...(vatApplicable && {
        taxDetails: {
          type: 'vat',
          rate: (vatRate || 0) / 100, // Convert percentage to decimal
          isInclusive: vatPricesIncludeVat,
          jurisdiction: 'BD',
        },
      }),
    };

    const existing = await Transaction.findById(transaction._id)
      .select('amount fee')
      .lean();

    if (existing?.amount !== undefined) {
      const fee = existing.fee || 0;
      const taxValue = taxUpdate.tax || 0;
      taxUpdate.net = existing.amount - fee - taxValue;
    }

    await Promise.all([
      Transaction.findByIdAndUpdate(transaction._id, taxUpdate),
      revenue.payments.verify(transaction._id, { verifiedBy: cashierId }),
      orderRepository.update(orderId, { 'currentPayment.transactionId': transaction._id }),
    ]);

    logger.info(
      { jobId: job.jobId, orderId, transactionId: transaction._id },
      'POS transaction created successfully'
    );
  }

  return { transactionId: transaction?._id };
}

// ============================================
// JOB REGISTRATION
// ============================================

/**
 * Register POS job handlers with the job queue
 * @param {Object} jobQueue - JobQueue instance
 */
function registerPosJobHandlers(jobQueue) {
  jobQueue.registerHandler(
    POS_JOB_TYPES.CREATE_TRANSACTION,
    handleCreateTransaction,
    {
      maxRetries: 5,
      timeout: 30000, // 30 seconds
    }
  );
}

// Register with the central registry
registerModule('pos', registerPosJobHandlers);

export default { POS_JOB_TYPES, handleCreateTransaction };
