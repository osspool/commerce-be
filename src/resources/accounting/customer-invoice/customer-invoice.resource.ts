/**
 * Customer Invoices Resource — A/R view over JournalEntry, account 1141.
 *
 * Filtering, schema, /open endpoint, and shared FSM scaffolding live in
 * `defineControlAccountResource()` (../_shared/control-account-resource.factory).
 * Adding a sibling A/R-style surface (e.g. Loan Receivables, Employee
 * Advances) is one config object — no copy-paste of repo wrappers.
 *
 * Customer invoices are not a separate model — they are JournalEntry docs
 * whose journalItems carry a partnerId on the A/R control account. Writes
 * are routed exclusively through declarative `actions` (post / receive /
 * debit-note) so double-entry, credit-limit, and idempotency contracts run.
 */

import { defineControlAccountResource } from '../_shared/control-account-resource.factory.js';
import {
  customerInvoiceActionPermissions,
  customerInvoiceActions,
} from './customer-invoice.actions.js';

const customerInvoiceResource = defineControlAccountResource({
  side: 'receivable',
  controlCode: '1141',
  partnerType: 'customer',
  partnerQueryKey: 'customerId',

  name: 'customer-invoice',
  displayName: 'Customer Invoices',
  tag: 'Accounting - Customer Invoices (A/R)',
  prefix: '/accounting/customer-invoices',

  actions: customerInvoiceActions,
  actionPermissions: customerInvoiceActionPermissions,
});

export default customerInvoiceResource;
