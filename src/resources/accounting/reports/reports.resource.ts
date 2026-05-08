/**
 * Financial Reports Resource
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Handlers live in reports.handlers.ts; pure parsers/math in reports.utils.ts.
 * All reports are powered by @classytic/ledger (MongoDB aggregation pipelines).
 */
import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';
import { getClearingAging } from './clearing-aging.report.js';
import {
  getApAging,
  getArAging,
  getBalanceSheet,
  getBudgetVsActual,
  getCashFlow,
  getDaybook,
  getGeneralLedger,
  getIncomeStatement,
  getPartnerLedger,
  getTrialBalance,
} from './reports.handlers.js';
import { budgetVsActualQuerySchema, dateQuerySchema } from './reports.utils.js';

const authenticated = requireAuth();

// biome-ignore lint/suspicious/noExplicitAny: Arc route typing is loose
const routes: any[] = [
  {
    method: 'GET',
    path: '/trial-balance',
    summary: 'Trial Balance report',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getTrialBalance,
  },
  {
    method: 'GET',
    path: '/balance-sheet',
    summary: 'Balance Sheet report',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getBalanceSheet,
  },
  {
    method: 'GET',
    path: '/income-statement',
    summary: 'Income Statement (Profit & Loss)',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getIncomeStatement,
  },
  {
    method: 'GET',
    path: '/income',
    summary: 'Income Statement (alias)',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getIncomeStatement,
  },
  {
    method: 'GET',
    path: '/general-ledger',
    summary: 'General Ledger report',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getGeneralLedger,
  },
  {
    method: 'GET',
    path: '/cash-flow',
    summary: 'Cash Flow report',
    permissions: authenticated,
    raw: true,
    schema: { querystring: dateQuerySchema },
    handler: getCashFlow,
  },
  {
    method: 'GET',
    path: '/ap-aging',
    summary: 'Accounts Payable aging (subsidiary ledger)',
    permissions: authenticated,
    raw: true,
    handler: getApAging,
  },
  {
    method: 'GET',
    path: '/ar-aging',
    summary: 'Accounts Receivable aging (subsidiary ledger)',
    permissions: authenticated,
    raw: true,
    handler: getArAging,
  },
  {
    method: 'GET',
    path: '/partner-ledger',
    summary: 'Per-partner ledger / supplier or customer statement',
    permissions: authenticated,
    raw: true,
    handler: getPartnerLedger,
  },
  {
    method: 'GET',
    path: '/daybook',
    summary: 'Daybook (flat journal-item listing for a date range — auditor view)',
    permissions: authenticated,
    raw: true,
    handler: getDaybook,
  },
  {
    method: 'GET',
    path: '/clearing-aging',
    summary: 'Clearing-account aging — open balances per clearing (1125/1126/1127) bucketed by age',
    permissions: authenticated,
    raw: true,
    handler: getClearingAging,
  },
];

routes.push({
  method: 'GET',
  path: '/budget-vs-actual',
  summary: 'Budget vs Actual report',
  permissions: authenticated,
  raw: true,
  schema: { querystring: budgetVsActualQuerySchema },
  handler: getBudgetVsActual,
});

const reportsResource = defineResource({
  name: 'accounting-reports',
  displayName: 'Financial Reports',
  tag: 'Accounting',
  prefix: '/accounting/reports',
  disableDefaultRoutes: true,
  routes,
});

export default reportsResource;
