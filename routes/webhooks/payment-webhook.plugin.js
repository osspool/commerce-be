import { verifyManualPayment, rejectManualPayment } from './handlers/manual-verification.handler.js';
import { handleProviderWebhook } from './handlers/provider-webhook.handler.js';
import { manualVerificationBody, manualRejectionBody, providerParams } from './schemas/payment-webhook.schemas.js';

/**
 * Payment Webhook Plugin
 * Simple, direct route registration
 */
export default async function paymentWebhookPlugin(fastify) {
  console.log('Payment webhook plugin loading...');

  // Manual verification route
  fastify.post('/manual/verify', {
    schema: {
      tags: ['Payments'],
      summary: 'Verify manual payment',
      description: 'Superadmin verifies manual payments (cash, bank transfer, mobile money)',
      body: manualVerificationBody,
    },
    onRequest: fastify.authenticate,
    preHandler: fastify.authorize('superadmin'),
  }, verifyManualPayment);

  console.log('OK: Manual verification route registered');

  // Manual rejection route
  fastify.post('/manual/reject', {
    schema: {
      tags: ['Payments'],
      summary: 'Reject manual payment',
      description: 'Superadmin rejects manual payments (invalid reference, fraud, etc.)',
      body: manualRejectionBody,
    },
    onRequest: fastify.authenticate,
    preHandler: fastify.authorize('superadmin'),
  }, rejectManualPayment);

  console.log('OK: Manual rejection route registered');

  // Provider webhook route
  fastify.post('/:provider', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Payment provider webhook',
      description: 'Handles webhooks from automatic payment providers (Stripe, SSLCommerz, bKash, Nagad)',
      params: providerParams,
    },
  }, handleProviderWebhook);

  console.log('OK: Provider webhook route registered');
  console.log('OK: Payment webhook plugin loaded successfully');
}
