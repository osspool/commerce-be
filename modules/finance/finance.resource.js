import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { getStatement } from '#modules/transaction/handlers/statement.handler.js';
import { getFinanceSummary } from './handlers/summary.handler.js';

const financeResource = defineResource({
  name: 'finance',
  displayName: 'Finance',
  tag: 'Finance',
  prefix: '/finance',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/summary',
      summary: 'Finance dashboard summary (BD day + branch)',
      description: 'Aggregates income/expense/net by BD day, branch, and payment method.',
      permissions: permissions.finance.any,
      wrapHandler: false,
      handler: getFinanceSummary,
    },
    {
      method: 'GET',
      path: '/statements',
      summary: 'Export finance statement (CSV/JSON)',
      description: 'Wrapper around transactions statement export, for finance backoffice.',
      permissions: permissions.finance.any,
      wrapHandler: false,
      handler: getStatement,
    },
  ],
});

export default financeResource;
