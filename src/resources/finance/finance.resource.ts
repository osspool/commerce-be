import { defineResource } from '@classytic/arc';
import { getStatement } from '#resources/transaction/handlers/statement.handler.js';
import { financeActions } from '#shared/permissions.js';
import { getFinanceSummary } from './handlers/summary.handler.js';

const financeResource = defineResource({
  name: 'finance',
  displayName: 'Finance',
  tag: 'Finance',
  prefix: '/finance',

  disableDefaultRoutes: true,

  routes: [
    {
      method: 'GET',
      path: '/summary',
      summary: 'Finance dashboard summary (BD day + branch)',
      description: 'Aggregates income/expense/net by BD day, branch, and payment method.',
      permissions: financeActions.any,
      raw: true,
      handler: getFinanceSummary as any,
    },
    {
      method: 'GET',
      path: '/statements',
      summary: 'Export finance statement (CSV/JSON)',
      description: 'Wrapper around transactions statement export, for finance backoffice.',
      permissions: financeActions.any,
      raw: true,
      handler: getStatement as any,
    },
  ],
});

export default financeResource;
