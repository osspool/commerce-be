import fp from 'fastify-plugin';
import { Revenue } from '@classytic/revenue';
import { definePlugin } from '@classytic/revenue/plugins';
import { ManualProvider } from '@classytic/revenue-manual';
import config from '#config/index.js';
import Transaction from '#modules/transaction/transaction.model.js';
import Order from '#modules/sales/orders/order.model.js';
import { updateEntityAfterPaymentVerification } from '#shared/revenue/payment-verification.utils.js';

let revenueInstance = null;

/**
 * Create ecommerce hooks plugin for payment verification and refund enrichment
 */
function createEcommerceHooksPlugin(fastify) {
  return definePlugin({
    name: 'ecommerce-hooks',
    version: '1.0.0',
    hooks: {
      // After payment verification, update the Order
      'payment.verify.after': async (ctx, input, next) => {
        const result = await next();
        const { transaction } = result;

        fastify.log.info('Payment verified', {
          transactionId: transaction._id,
          amount: transaction.amount,
          sourceModel: transaction.sourceModel,
          sourceId: transaction.sourceId,
        });

        // Update the Order after payment verification
        if (transaction.sourceModel && transaction.sourceId) {
          await updateEntityAfterPaymentVerification(
            transaction.sourceModel,
            transaction.sourceId,
            transaction,
            fastify.log
          );
        }

        return result;
      },

      // After refund, enrich refund transaction with order context and tax data
      'payment.refund.after': async (ctx, input, next) => {
        const result = await next();
        const { transaction, refundTransaction } = result;

        // Calculate refundAmount and isPartialRefund from refundTransaction
        // (revenue library doesn't include these in the result)
        const refundAmount = refundTransaction.amount;
        const isPartialRefund = refundAmount < transaction.amount;

        fastify.log.info('Payment refunded', {
          originalTransactionId: transaction._id,
          refundTransactionId: refundTransaction._id,
          refundAmount,
          isPartialRefund,
          sourceModel: transaction.sourceModel,
          sourceId: transaction.sourceId,
        });

        // Enrich refund transaction for finance statements
        try {
          let order = null;
          if (transaction.sourceModel === 'Order' && transaction.sourceId) {
            order = await Order.findById(transaction.sourceId)
              .select('branch vat')
              .populate('branch', 'code')
              .lean();
          }

          // Calculate proportional tax for refund
          // For partial refunds, tax is proportional to refund amount
          let refundTax = 0;
          let refundTaxDetails = null;

          // Prefer original transaction's tax data, fallback to order VAT
          const originalTax = transaction.tax || 0;
          const originalTaxDetails = transaction.taxDetails;

          if (originalTax > 0) {
            // Calculate proportional tax based on refund ratio
            const refundRatio = refundAmount / transaction.amount;
            refundTax = Math.round(originalTax * refundRatio);
            refundTaxDetails = originalTaxDetails;
          } else if (order?.vat?.applicable && order?.vat?.amount > 0) {
            // Fallback: calculate from order VAT (convert to paisa)
            const orderVatInPaisa = Math.round(order.vat.amount * 100);
            const orderAmountInPaisa = transaction.amount;
            const refundRatio = refundAmount / orderAmountInPaisa;
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
              ...(order?.branch?._id ? { branch: order.branch._id } : (transaction.branch ? { branch: transaction.branch } : {})),
              // Tax data for refund (proportional to refund amount)
              tax: refundTax,
              ...(refundTaxDetails && { taxDetails: refundTaxDetails }),
              metadata: {
                ...(refundTransaction.metadata || {}),
                orderId: transaction.sourceId?.toString?.() || null,
                vatInvoiceNumber: order?.vat?.invoiceNumber || transaction.metadata?.vatInvoiceNumber || null,
                vatSellerBin: order?.vat?.sellerBin || transaction.metadata?.vatSellerBin || null,
                branchCode: order?.branch?.code || transaction.metadata?.branchCode || null,
                refundAmount,
                isPartialRefund,
                originalTax: originalTax || null,
                refundTax: refundTax || null,
              },
            },
          }).catch(() => {});
        } catch (e) {
          fastify.log.warn('Refund transaction enrichment failed', { error: e.message });
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

async function revenuePlugin(fastify) {
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
      .build();

    fastify.log.info('Revenue system initialized', {
      providers: Object.keys(revenueInstance.providers),
    });

    // Register event listeners for better observability
    revenueInstance.on('monetization.created', (event) => {
      fastify.log.info('Monetization created', {
        monetizationType: event.monetizationType,
        sourceModel: event.transaction?.sourceModel,
        amount: event.transaction?.amount,
      });
    });

    revenueInstance.on('payment.verified', (event) => {
      fastify.log.info('Payment verified', {
        transactionId: event.transaction._id,
        amount: event.transaction.amount,
        verifiedBy: event.verifiedBy,
      });
    });

    revenueInstance.on('payment.failed', (event) => {
      fastify.log.error('Payment failed', {
        transactionId: event.transaction._id,
        error: event.error,
        provider: event.provider,
      });
    });

    revenueInstance.on('payment.refunded', (event) => {
      fastify.log.info('Payment refunded', {
        transactionId: event.transaction._id,
        refundAmount: event.refundAmount,
        isPartialRefund: event.isPartialRefund,
      });
    });

    fastify.decorate('revenue', revenueInstance);
  } catch (error) {
    fastify.log.error('Failed to initialize revenue system', { error: error.message });
    throw error;
  }
}

export function getRevenue() {
  if (!revenueInstance) {
    throw new Error('Revenue system not initialized. Ensure revenuePlugin is registered.');
  }
  return revenueInstance;
}

export default fp(revenuePlugin, {
  name: 'revenue',
  dependencies: ['register-core-plugins'],
});
