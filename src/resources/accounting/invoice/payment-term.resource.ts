/**
 * PaymentTerm Resource — Arc CRUD against `@classytic/invoice`'s PaymentTerm
 * model. Replaces the old `GET/POST /accounting/invoices/payment-terms*` raw
 * routes that lived inside invoice.resource.ts.
 *
 * Registration mirrors the main invoice resource: a no-op placeholder default
 * export keeps auto-discovery happy when the engine is disabled, and
 * `buildPaymentTermResource(model, repo)` is registered from invoice.plugin.ts
 * after engine init so the live Mongoose model + mongokit repo wire into
 * `createMongooseAdapter` directly.
 *
 * Custom raw route `/:id/schedule` stays here — it's a computed projection
 * (PaymentTermService.computeSchedule), not state mutation.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireAuth } from '@classytic/arc/permissions';
import { QueryParser } from '@classytic/mongokit';
import { requireFinanceManager } from '#shared/permissions.js';
import { computeInstallmentSchedule } from './invoice.handlers.js';

const placeholder = defineResource({
  name: 'payment-terms',
  displayName: 'Payment Terms',
  tag: 'Accounting - Payment Terms',
  prefix: '/accounting/payment-terms',
  disableDefaultRoutes: true,
  routes: [],
  skipValidation: true,
});

export default placeholder;

export function buildPaymentTermResource(
  // biome-ignore lint/suspicious/noExplicitAny: engine models are loosely typed
  model: any,
  // biome-ignore lint/suspicious/noExplicitAny: engine repos are loosely typed
  repo: any,
) {
  const authenticated = requireAuth();
  const financeRoles = requireFinanceManager();

  const queryParser = new QueryParser({
    maxLimit: 200,
    allowedFilterFields: ['name', 'active', 'displayOnInvoice'],
    allowedSortFields: ['name', 'createdAt'],
  });

  return defineResource({
    name: 'payment-terms-crud',
    displayName: 'Payment Terms',
    tag: 'Accounting - Payment Terms',
    prefix: '/accounting/payment-terms',

    adapter: createMongooseAdapter(model, repo),
    queryParser,

    permissions: {
      list: authenticated,
      get: authenticated,
      create: financeRoles,
      update: financeRoles,
      delete: financeRoles,
    },

    schemaOptions: {
      fieldRules: {
        publicId: { systemManaged: true },
      },
    },

    routes: [
      {
        method: 'POST',
        path: '/:id/schedule',
        summary: 'Compute installment schedule for a payment term',
        permissions: authenticated,
        raw: true,
        handler: computeInstallmentSchedule,
      },
    ],
  });
}
