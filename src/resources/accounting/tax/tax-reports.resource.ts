import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { getAtReconciliation, getExportRefund, getVdsPayable, getVdsReceivable } from './tax-reports.handlers.js';

const authenticated = requireAuth();

// biome-ignore lint/suspicious/noExplicitAny: Arc route typing is loose
const routes: any[] = [
  {
    method: 'GET',
    path: '/at-reconciliation',
    summary: 'Advance VAT / AT reconciliation per period',
    permissions: authenticated,
    raw: true,
    handler: getAtReconciliation,
  },
  {
    method: 'GET',
    path: '/vds-receivable',
    summary: 'VDS withheld from us by buyers — receivable balance',
    permissions: authenticated,
    raw: true,
    handler: getVdsReceivable,
  },
  {
    method: 'GET',
    path: '/vds-payable',
    summary: 'VDS we withheld — payable to NBR',
    permissions: authenticated,
    raw: true,
    handler: getVdsPayable,
  },
  {
    method: 'GET',
    path: '/export-refund',
    summary: 'Export refund claimable (zero-rated input VAT bucket)',
    permissions: authenticated,
    raw: true,
    handler: getExportRefund,
  },
];

const taxReportsResource = defineResource({
  name: 'tax-reports',
  displayName: 'Tax Reports',
  tag: 'Accounting',
  prefix: '/accounting/tax/reports',
  disableDefaultRoutes: true,
  routes,
});

export default taxReportsResource;
