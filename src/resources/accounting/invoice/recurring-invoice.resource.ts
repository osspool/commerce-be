/**
 * RecurringInvoice Resource — Arc CRUD against `@classytic/invoice`'s
 * RecurringInvoice model. Replaces the old
 * `GET/POST /accounting/invoices/recurring` raw routes that lived inside
 * invoice.resource.ts.
 *
 * Same registration pattern as payment-term.resource.ts — placeholder for
 * auto-discovery, real wiring in invoice.plugin.ts after engine init.
 *
 * The `/recurring/process` workflow trigger stays in invoice.resource.ts as
 * a raw route — it's a non-id-scoped operation that fans out across all
 * active configs, so it doesn't fit either CRUD or per-doc actions.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import { QueryParser } from '@classytic/mongokit';

const placeholder = defineResource({
  name: 'recurring-invoices',
  displayName: 'Recurring Invoices',
  tag: 'Accounting - Recurring Invoices',
  prefix: '/accounting/recurring-invoices',
  disableDefaultRoutes: true,
  routes: [],
  skipValidation: true,
});

export default placeholder;

export function buildRecurringInvoiceResource(
  // biome-ignore lint/suspicious/noExplicitAny: engine models are loosely typed
  model: any,
  // biome-ignore lint/suspicious/noExplicitAny: engine repos are loosely typed
  repo: any,
) {
  const authenticated = requireAuth();
  const financeRoles = requireRoles('admin', 'finance_admin', 'finance_manager');

  const queryParser = new QueryParser({
    maxLimit: 200,
    allowedFilterFields: ['active', 'partnerId', 'frequency'],
    allowedSortFields: ['nextRun', 'createdAt'],
  });

  return defineResource({
    name: 'recurring-invoices-crud',
    displayName: 'Recurring Invoices',
    tag: 'Accounting - Recurring Invoices',
    prefix: '/accounting/recurring-invoices',

    adapter: createMongooseAdapter(model, repo),
    queryParser,

    permissions: {
      list: authenticated,
      get: authenticated,
      create: financeRoles,
      update: financeRoles,
      delete: financeRoles,
    },
  });
}
