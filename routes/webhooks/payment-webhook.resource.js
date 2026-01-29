/**
 * Payment Webhook Resource
 *
 * Handles payment webhooks from manual verification and automatic providers.
 * Uses disableDefaultRoutes: true since no CRUD operations are needed.
 */
import { defineResource } from '@classytic/arc';
import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { verifyManualPayment, rejectManualPayment } from './handlers/manual-verification.handler.js';
import { handleProviderWebhook } from './handlers/provider-webhook.handler.js';
import {
  manualVerificationBody,
  manualRejectionBody,
  providerParams,
} from './schemas/payment-webhook.schemas.js';

const paymentWebhookResource = defineResource({
  name: 'payment-webhook',
  displayName: 'Payment Webhook',
  tag: 'Payments',
  prefix: '/webhooks/payments',
  // No controller/repository needed - only custom routes
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/manual/verify',
      handler: verifyManualPayment,
      summary: 'Verify manual payment',
      description: 'Superadmin verifies manual payments',
      permissions: requireRoles(['superadmin']),
      wrapHandler: false,
      schema: {
        body: manualVerificationBody,
      },
    },
    {
      method: 'POST',
      path: '/manual/reject',
      handler: rejectManualPayment,
      summary: 'Reject manual payment',
      description: 'Superadmin rejects manual payments',
      permissions: requireRoles(['superadmin']),
      wrapHandler: false,
      schema: {
        body: manualRejectionBody,
      },
    },
    {
      method: 'POST',
      path: '/:provider',
      handler: handleProviderWebhook,
      summary: 'Payment provider webhook',
      description: 'Handles webhooks from automatic payment providers',
      permissions: allowPublic(),
      wrapHandler: false,
      schema: {
        params: providerParams,
      },
      tags: ['Webhooks'],
    },
  ],
});

export default paymentWebhookResource;
