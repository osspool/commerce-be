import fp from 'fastify-plugin';
import { Revenue } from '@classytic/revenue';
import { definePlugin } from '@classytic/revenue/plugins';
import { ManualProvider } from '@classytic/revenue-manual';
import config from '#config/index.js';
import Transaction from '#resources/transaction/transaction.model.js';
import Order from '#resources/sales/orders/order.model.js';
import { updateEntityAfterPaymentVerification } from '#shared/revenue/payment-verification.utils.js';
import type { FastifyInstance } from 'fastify';
import type { Types } from 'mongoose';

interface RevenueTransaction {
  _id: Types.ObjectId;
  amount: number;
  currency: string;
  method: string;
  sourceModel?: string;
  sourceId?: string;
  source?: string;
  branch?: Types.ObjectId;
  tax?: number;
  taxDetails?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  verifiedAt?: Date;
  verifiedBy?: Types.ObjectId;
  paymentDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

interface HookResult {
  transaction: RevenueTransaction;
  refundTransaction: RevenueTransaction;
  refundAmount?: number;
  isPartialRefund?: boolean;
  [key: string]: unknown;
}

interface RevenueEvent {
  monetizationType?: string;
  transaction?: RevenueTransaction;
  amount?: number;
  verifiedBy?: string;
  error?: string;
  provider?: string;
  refundAmount?: number;
  isPartialRefund?: boolean;
  [key: string]: unknown;
}

interface RevenueInstance {
  providers: Record<string, unknown>;
  on(event: string, handler: (event: RevenueEvent) => void): void;
  [key: string]: unknown;
}

interface OrderVat {
  applicable?: boolean;
  amount?: number;
  rate?: number;
  pricesIncludeVat?: boolean;
  invoiceNumber?: string;
  sellerBin?: string;
}

interface PopulatedOrder {
  _id: Types.ObjectId;
  branch?: { _id: Types.ObjectId; code?: string };
  vat?: OrderVat;
}

let revenueInstance: RevenueInstance | null = null;

/**
 * Create ecommerce hooks plugin for payment verification and refund enrichment
 */
function createEcommerceHooksPlugin(fastify: FastifyInstance) {
  return definePlugin({
    name: 'ecommerce-hooks',
    version: '1.0.0',
    hooks: {
      // After payment verification, update the Order
      'payment.verify.after': async (_ctx: unknown, _input: unknown, next: () => Promise<any>) => {
        const result = await next();
        const { transaction } = result;

        fastify.log.info(
          {
            transactionId: transaction._id,
            amount: transaction.amount,
            sourceModel: transaction.sourceModel,
            sourceId: transaction.sourceId,
          },
          'Payment verified',
        );

        // Update the Order after payment verification
        if (transaction.sourceModel && transaction.sourceId) {
          await updateEntityAfterPaymentVerification(
            transaction.sourceModel,
            transaction.sourceId,
            transaction,
            fastify.log,
          );
        }

        return result;
      },

      // After refund, enrich refund transaction with order context and tax data
      'payment.refund.after': async (_ctx: unknown, _input: unknown, next: () => Promise<any>) => {
        const result = await next();
        const { transaction, refundTransaction } = result;

        // Calculate refundAmount and isPartialRefund from refundTransaction
        // (revenue library doesn't include these in the result)
        const refundAmount: number = refundTransaction.amount;
        const isPartialRefund: boolean = refundAmount < transaction.amount;

        fastify.log.info(
          {
            originalTransactionId: transaction._id,
            refundTransactionId: refundTransaction._id,
            refundAmount,
            isPartialRefund,
            sourceModel: transaction.sourceModel,
            sourceId: transaction.sourceId,
          },
          'Payment refunded',
        );

        // Enrich refund transaction for finance statements
        try {
          let order: PopulatedOrder | null = null;
          if (transaction.sourceModel === 'Order' && transaction.sourceId) {
            order = (await Order.findById(transaction.sourceId)
              .select('branch vat')
              .populate('branch', 'code')
              .lean()) as PopulatedOrder | null;
          }

          // Calculate proportional tax for refund
          // For partial refunds, tax is proportional to refund amount
          let refundTax = 0;
          let refundTaxDetails: Record<string, unknown> | null = null;

          // Prefer original transaction's tax data, fallback to order VAT
          const originalTax: number = (transaction.tax as number) || 0;
          const originalTaxDetails = transaction.taxDetails;

          if (originalTax > 0) {
            // Calculate proportional tax based on refund ratio
            const refundRatio: number = refundAmount / transaction.amount;
            refundTax = Math.round(originalTax * refundRatio);
            refundTaxDetails = originalTaxDetails as Record<string, unknown> | null;
          } else if (order?.vat?.applicable && order?.vat?.amount && order.vat.amount > 0) {
            // Fallback: calculate from order VAT (convert to paisa)
            const orderVatInPaisa: number = Math.round(order.vat.amount * 100);
            const orderAmountInPaisa: number = transaction.amount;
            const refundRatio: number = refundAmount / orderAmountInPaisa;
            refundTax = Math.round(orderVatInPaisa * refundRatio);
            refundTaxDetails = {
              type: 'vat',
              rate: (order.vat.rate || 0) / 100,
              isInclusive: order.vat.pricesIncludeVat ?? true,
              jurisdiction: 'BD',
            };
          }

          await Transaction.findByIdAndUpdate(refundTransaction._id, {
            $set: {
              source: transaction.source || 'web',
              ...(order?.branch?._id
                ? { branch: order.branch._id }
                : transaction.branch
                  ? { branch: transaction.branch }
                  : {}),
              // Tax data for refund (proportional to refund amount)
              tax: refundTax,
              ...(refundTaxDetails && { taxDetails: refundTaxDetails }),
              metadata: {
                ...(refundTransaction.metadata || {}),
                orderId: transaction.sourceId?.toString?.() || null,
                vatInvoiceNumber:
                  order?.vat?.invoiceNumber ||
                  (transaction.metadata as Record<string, unknown>)?.vatInvoiceNumber ||
                  null,
                vatSellerBin:
                  order?.vat?.sellerBin || (transaction.metadata as Record<string, unknown>)?.vatSellerBin || null,
                branchCode:
                  order?.branch?.code || (transaction.metadata as Record<string, unknown>)?.branchCode || null,
                refundAmount,
                isPartialRefund,
                originalTax: originalTax || null,
                refundTax: refundTax || null,
              },
            },
          }).catch(() => {});
        } catch (e) {
          const err = e as Error;
          fastify.log.warn({ error: err.message }, 'Refund transaction enrichment failed');
        }

        // Add missing fields to result for backward compatibility with tests
        // (revenue library v1.1.1 doesn't include these)
        return {
          ...result,
          refundAmount,
          isPartialRefund,
        };
      },
    },
  });
}

async function revenuePlugin(fastify: FastifyInstance): Promise<void> {
  fastify.log.info('Initializing revenue system');

  try {
    fastify.log.info('Initializing Manual payment provider for Bangladesh ecommerce');

    revenueInstance = Revenue.create({
      defaultCurrency: 'BDT',
    })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .withLogger(fastify.log)
      .forEnvironment(config.isProduction ? 'production' : 'development')
      .withDebug(!config.isProduction)
      .withRetry({ maxAttempts: 3, baseDelay: 1000 })
      .withCircuitBreaker(config.isProduction)
      .withCategoryMappings({
        Order: 'order_purchase',
      })
      .withTransactionTypeMapping({
        order_purchase: 'inflow',
        refund: 'outflow',
      })
      .withPlugin(createEcommerceHooksPlugin(fastify))
      .build() as unknown as RevenueInstance;

    fastify.log.info(
      {
        providers: Object.keys(revenueInstance.providers),
      },
      'Revenue system initialized',
    );

    // Register event listeners for better observability
    revenueInstance.on('monetization.created', (event: RevenueEvent) => {
      fastify.log.info(
        {
          monetizationType: event.monetizationType,
          sourceModel: event.transaction?.sourceModel,
          amount: event.transaction?.amount,
        },
        'Monetization created',
      );
    });

    revenueInstance.on('payment.verified', (event: RevenueEvent) => {
      fastify.log.info(
        {
          transactionId: event.transaction?._id,
          amount: event.transaction?.amount,
          verifiedBy: event.verifiedBy,
        },
        'Payment verified',
      );

      // Bridge verified payment to accounting — outbox ensures durability
      // Accounting handler filters POS vs online based on transaction.source
      if (config.accounting?.enabled && event.transaction?._id) {
        import('#shared/outbox/index.js')
          .then(({ outbox }) => {
            import('@classytic/arc/events')
              .then(({ createEvent }) => {
                outbox
                  .store(
                    createEvent('accounting:order.paid', {
                      transactionId: event.transaction?._id.toString(),
                    }),
                  )
                  .catch((err: Error) => {
                    fastify.log.warn({ err: err.message }, 'Failed to store accounting:order.paid in outbox');
                  });
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    });

    revenueInstance.on('payment.failed', (event: RevenueEvent) => {
      fastify.log.error(
        {
          transactionId: event.transaction?._id,
          error: event.error,
          provider: event.provider,
        },
        'Payment failed',
      );
    });

    revenueInstance.on('payment.refunded', (event: RevenueEvent) => {
      fastify.log.info(
        {
          transactionId: event.transaction?._id,
          refundAmount: event.refundAmount,
          isPartialRefund: event.isPartialRefund,
        },
        'Payment refunded',
      );
    });

    fastify.decorate('revenue', revenueInstance);
  } catch (error) {
    const err = error as Error;
    fastify.log.error({ error: err.message }, 'Failed to initialize revenue system');
    throw error;
  }
}

export function getRevenue(): RevenueInstance {
  if (!revenueInstance) {
    throw new Error('Revenue system not initialized. Ensure revenuePlugin is registered.');
  }
  return revenueInstance;
}

export default fp(revenuePlugin, {
  name: 'revenue',
  dependencies: ['register-core-plugins'],
});
