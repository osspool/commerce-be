/**
 * Payment Webhook Resource
 *
 * Service-only Arc resource mounted outside `/api/v1`.
 */

import { defineResource } from '@classytic/arc';
import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { rejectManualPayment, verifyManualPayment } from './handlers/manual-verification.handler.js';
import { handleProviderWebhook } from './handlers/provider-webhook.handler.js';
import { manualRejectionBody, manualVerificationBody, providerParams } from './schemas/payment-webhook.schemas.js';
import { buildWebhookRateLimit } from './webhook-rate-limit.js';

const paymentWebhookResource = defineResource({
  name: 'payment-webhook',
  displayName: 'Payment Webhook',
  tag: 'Payments',
  prefix: '/webhooks/payments',
  skipGlobalPrefix: true,
  disableDefaultRoutes: true,
  rateLimit: buildWebhookRateLimit(),
  routes: [
    {
      method: 'POST',
      path: '/manual/verify',
      handler: verifyManualPayment,
      summary: 'Verify manual payment',
      description: 'Superadmin verifies manual payments',
      permissions: requireRoles(['superadmin']),
      raw: true,
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
      raw: true,
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
      raw: true,
      schema: {
        params: providerParams,
      },
      tags: ['Webhooks'],
    },
  ],
});

export default paymentWebhookResource;
