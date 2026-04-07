/**
 * Financial Reports Resource
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Handlers live in reports.handlers.ts; pure parsers/math in reports.utils.ts.
 * All reports are powered by @classytic/ledger (MongoDB aggregation pipelines).
 */
import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import config from '#config/index.js';
import { dateQuerySchema, budgetVsActualQuerySchema } from './reports.utils.js';
import {
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
  getCashFlow,
  getGeneralLedger,
  getBudgetVsActual,
} from './reports.handlers.js';

const authenticated = requireAuth();

// biome-ignore lint/suspicious/noExplicitAny: Arc additionalRoute typing is loose
const additionalRoutes: any[] = [
  {
    method: 'GET',
    path: '/trial-balance',
    summary: 'Trial Balance report',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getTrialBalance,
  },
  {
    method: 'GET',
    path: '/balance-sheet',
    summary: 'Balance Sheet report',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getBalanceSheet,
  },
  {
    method: 'GET',
    path: '/income-statement',
    summary: 'Income Statement (Profit & Loss)',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getIncomeStatement,
  },
  {
    method: 'GET',
    path: '/income',
    summary: 'Income Statement (alias)',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getIncomeStatement,
  },
  {
    method: 'GET',
    path: '/general-ledger',
    summary: 'General Ledger report',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getGeneralLedger,
  },
  {
    method: 'GET',
    path: '/cash-flow',
    summary: 'Cash Flow report',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: dateQuerySchema },
    handler: getCashFlow,
  },
];

if (config.accounting.mode !== 'simple') {
  additionalRoutes.push({
    method: 'GET',
    path: '/budget-vs-actual',
    summary: 'Budget vs Actual report (enterprise)',
    permissions: authenticated,
    wrapHandler: false,
    schema: { querystring: budgetVsActualQuerySchema },
    handler: getBudgetVsActual,
  });
}

const reportsResource = defineResource({
  name: 'accounting-reports',
  displayName: 'Financial Reports',
  tag: 'Accounting',
  prefix: '/accounting/reports',
  disableDefaultRoutes: true,
  additionalRoutes,
});

export default reportsResource;
