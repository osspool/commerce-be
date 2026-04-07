/**
 * POS Event Handlers
 *
 * Subscribes to Arc events for POS operations (replaces job queue).
 */

import { subscribe } from '#lib/events/arcEvents.js';
import { withRetry } from '@classytic/arc/events';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { toSmallestUnit } from '@classytic/revenue';
import Transaction from '#resources/transaction/transaction.model.js';
import orderRepository from '#resources/sales/orders/order.repository.js';
import logger from '#lib/utils/logger.js';

// ============================================
// TYPES
// ============================================

export interface PosTransactionJobData {
  orderId: string;
  customerId: string;
  totalAmount: number;
  branchId: string;
  branchCode: string;
  cashierId: string;
  paymentMethod: string;
  paymentReference?: string;
  paymentPayments?: Array<Record<string, unknown>>;
  vatInvoiceNumber?: string | null;
  vatSellerBin?: string | null;
  vatApplicable?: boolean;
  vatAmount?: number;
  vatRate?: number;
  vatPricesIncludeVat?: boolean;
  terminalId?: string;
  idempotencyKey: string;
}

interface PosJob {
  jobId: string;
  data: PosTransactionJobData;
}

// ============================================
// HANDLER
// ============================================

/**
 * Create financial transaction for a POS order
 */
export async function handleCreateTransaction(job: PosJob): Promise<{ transactionId: unknown }> {
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

  const resolvedCustomerId = customerId && customerId !== 'walk-in' ? customerId : null;

  const { transaction } = await (
    revenue as Record<string, unknown> as {
      monetization: {
        create: (opts: Record<string, unknown>) => Promise<{ transaction: Record<string, unknown> | null }>;
      };
    }
  ).monetization.create({
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
      terminalId,
      cashierId,
      vatInvoiceNumber,
      vatSellerBin,
      isSplitPayment,
    },
    idempotencyKey,
  });

  if (transaction) {
    const taxUpdate: Record<string, unknown> = {
      source: 'pos',
      branch: branchId,
      branchCode,
      tax: vatApplicable ? toSmallestUnit(vatAmount, 'BDT') : 0,
      ...(vatApplicable && {
        taxDetails: {
          type: 'vat',
          rate: (vatRate || 0) / 100,
          isInclusive: vatPricesIncludeVat,
          jurisdiction: 'BD',
        },
      }),
    };

    const existing = await Transaction.findById(transaction._id).select('amount fee').lean();

    if ((existing as Record<string, unknown>)?.amount !== undefined) {
      const fee = ((existing as Record<string, unknown>).fee as number) || 0;
      const taxValue = (taxUpdate.tax as number) || 0;
      taxUpdate.net = ((existing as Record<string, unknown>).amount as number) - fee - taxValue;
    }

    await Promise.all([
      Transaction.findByIdAndUpdate(transaction._id, taxUpdate),
      (
        revenue as Record<string, unknown> as {
          payments: { verify: (id: unknown, opts: Record<string, unknown>) => Promise<unknown> };
        }
      ).payments.verify(transaction._id, { verifiedBy: cashierId }),
      orderRepository.update(orderId, { 'currentPayment.transactionId': transaction._id }),
    ]);

    logger.info({ jobId: job.jobId, orderId, transactionId: transaction._id }, 'POS transaction created successfully');
  }

  return { transactionId: transaction?._id };
}

// ============================================
// EVENT REGISTRATION
// ============================================

/**
 * Register POS event handlers via Arc event bus
 */
export function registerPosEventHandlers(): void {
  subscribe(
    'pos:transaction.create',
    withRetry(
      async (event: unknown) => {
        const payload = (event as { payload: PosTransactionJobData }).payload;
        await handleCreateTransaction({ jobId: 'event', data: payload });
      },
      {
        maxRetries: 3,
        backoffMs: 2000,
        name: 'pos:transaction.create',
        onDead: (event) => {
          logger.error(
            { event, eventType: 'pos:transaction.create' },
            'POS transaction handler exhausted retries — event moved to dead letter',
          );
        },
      },
    ),
  );
}

export default { handleCreateTransaction, registerPosEventHandlers };
