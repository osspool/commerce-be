import fp from 'fastify-plugin';
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import Transaction from '#modules/transaction/transaction.model.js';
import { updateEntityAfterPaymentVerification } from '#common/revenue/payment-verification.utils.js';
import { createRevenueNotificationHandlers } from '#common/integrations/email-notifications/revenue-notifications.config.js';

let revenueInstance = null;

async function revenuePlugin(fastify) {
  fastify.log.info('Initializing revenue system');

  try {
    fastify.log.info('Initializing Manual payment provider for Bangladesh ecommerce');

    revenueInstance = Revenue.create({
      logger: fastify.log,
      defaultCurrency: 'BDT',
    })
      .withModels({ Transaction })
      .withProvider('manual', new ManualProvider())
      .withCategoryMappings({
        Order: 'order_purchase',
      })
      .withHooks({
        // Hook: Purchase created (order placed, awaiting payment)
        'purchase.created': [
          async ({ transaction, paymentIntent }) => {
            fastify.log.info('Purchase created', {
              transactionId: transaction?._id,
              paymentIntentId: paymentIntent?.id,
              amount: transaction?.amount,
              referenceModel: transaction?.referenceModel,
            });
          },
        ],

        // Hook: Manual payment verified by admin
        // This fires when admin calls revenue.payments.verify()
        'payment.verified': [
          async ({ transaction, verifiedBy }) => {
            fastify.log.info('Payment verified (manual)', {
              transactionId: transaction._id,
              amount: transaction.amount,
              referenceModel: transaction.referenceModel,
              referenceId: transaction.referenceId,
              verifiedBy,
            });

            // Update the Order after payment verification
            if (transaction.referenceModel && transaction.referenceId) {
              await updateEntityAfterPaymentVerification(
                transaction.referenceModel,
                transaction.referenceId,
                transaction,
                fastify.log
              );
            }
          },
        ],

        // Hook: Payment failed
        'payment.failed': [
          async ({ transaction, error }) => {
            fastify.log.error('Payment failed', {
              transactionId: transaction._id,
              reason: error || transaction.failureReason,
            });
          },
        ],

        // Hook: Provider webhook payment succeeded (for future Stripe/SSLCommerz integration)
        'payment.webhook.payment.succeeded': [
          async ({ transaction }) => {
            fastify.log.info('Webhook payment succeeded', {
              transactionId: transaction._id,
              amount: transaction.amount,
              referenceModel: transaction.referenceModel,
              referenceId: transaction.referenceId,
            });

            if (transaction.referenceModel && transaction.referenceId) {
              await updateEntityAfterPaymentVerification(
                transaction.referenceModel,
                transaction.referenceId,
                transaction,
                fastify.log
              );
            }
          },
        ],

        // Hook: Provider webhook payment failed
        'payment.webhook.payment.failed': [
          async ({ transaction }) => {
            fastify.log.error('Webhook payment failed', {
              transactionId: transaction._id,
              reason: transaction.failureReason,
            });
          },
        ],

        // Hook: Payment refunded
        // Fires when revenue.payments.refund() creates expense transaction
        // NOTE: Order state is managed by refundOrderWorkflow - this hook only logs
        // The workflow handles partial vs full refunds, status updates, timeline events,
        // and emits repository events for inventory/stats
        'payment.refunded': [
          async ({ transaction, refundTransaction, refundAmount, isPartialRefund }) => {
            fastify.log.info('Payment refunded', {
              originalTransactionId: transaction._id,
              refundTransactionId: refundTransaction._id,
              refundAmount,
              isPartialRefund,
              referenceModel: transaction.referenceModel,
              referenceId: transaction.referenceId,
            });
            // Order state changes are handled by refundOrderWorkflow
            // to properly manage partial vs full refunds and repository events
          },
        ],

        // Spread notification handlers (email notifications)
        ...createRevenueNotificationHandlers(),
      })
      .build();

    fastify.log.info('Revenue system initialized', {
      providers: Object.keys(revenueInstance.providers),
    });

    // Register event listeners for better observability
    revenueInstance.events.on('payment.initiated', (event) => {
      fastify.log.info('Payment initiated', {
        transactionId: event.transactionId,
        amount: event.amount,
        provider: event.provider,
      });
    });

    revenueInstance.events.on('payment.succeeded', (event) => {
      fastify.log.info('Payment succeeded', {
        transactionId: event.transactionId,
        amount: event.transaction.amount,
      });
    });

    revenueInstance.events.on('payment.failed', (event) => {
      fastify.log.error('Payment failed', {
        transactionId: event.transactionId,
        error: event.error.message,
        provider: event.provider,
      });
    });

    revenueInstance.events.on('transaction.created', (event) => {
      fastify.log.info('Transaction created', {
        transactionId: event.transactionId,
        type: event.transaction.type,
        status: event.transaction.status,
      });
    });

    revenueInstance.events.on('transaction.verified', (event) => {
      fastify.log.info('Transaction verified', {
        transactionId: event.transactionId,
        amount: event.transaction.amount,
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
