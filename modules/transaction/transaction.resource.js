/**
 * Transaction Resource Definition
 *
 * Payment & revenue system transactions.
 * Transactions are created by @classytic/revenue or by admin/superadmin manual entries.
 * This provides CRUD + financial reporting endpoints with role restrictions.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Transaction from './transaction.model.js';
import transactionRepository from './transaction.repository.js';
import transactionController from './transaction.controller.js';
import permissions from '#config/permissions.js';
import transactionSchemas from './schemas.js';
import { events } from './events.js';

// Import report handlers
import {
  getProfitLossReport,
  getCategoriesReport,
  getCashFlowReport,
} from './handlers/reports.handler.js';
import { getStatement } from './handlers/statement.handler.js';

const transactionResource = defineResource({
  name: 'transaction',
  displayName: 'Transactions',
  tag: 'Transaction',
  prefix: '/transactions',

  model: Transaction,
  repository: transactionRepository,
  controller: transactionController,

  permissions: permissions.transactions,
  schemaOptions: transactionSchemas,

  additionalRoutes: [
    // Statement export (accounting-friendly)
    {
      method: 'GET',
      path: '/statement',
      handler: getStatement,
      summary: 'Export transaction statement (CSV/JSON)',
      description: 'Accountant-friendly export with branch + VAT invoice references (defaults to CSV).',
      authRoles: permissions.transactions.reports,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            startDate: { type: 'string', format: 'date-time' },
            endDate: { type: 'string', format: 'date-time' },
            branchId: { type: 'string' },
            source: { type: 'string', enum: ['web', 'pos', 'api'] },
            status: { type: 'string' },
            format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
          },
        },
      },
    },
    // Financial Reports
    {
      method: 'GET',
      path: '/reports/profit-loss',
      handler: getProfitLossReport,
      summary: 'Get Profit & Loss report',
      description: 'Returns income, expenses, and net profit for a date range (default: last 30 days, max: 1 year)',
      authRoles: permissions.transactions.list,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            startDate: { type: 'string', format: 'date-time', description: 'Start date (ISO 8601)' },
            endDate: { type: 'string', format: 'date-time', description: 'End date (ISO 8601)' },
          },
        },
      },
    },
    {
      method: 'GET',
      path: '/reports/categories',
      handler: getCategoriesReport,
      summary: 'Get category breakdown',
      description: 'Returns top spending/income categories for a date range',
      authRoles: permissions.transactions.list,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            startDate: { type: 'string', format: 'date-time' },
            endDate: { type: 'string', format: 'date-time' },
            type: { type: 'string', enum: ['income', 'expense'], description: 'Filter by type' },
            limit: { type: 'integer', default: 10, description: 'Number of categories to return' },
          },
        },
      },
    },
    {
      method: 'GET',
      path: '/reports/cash-flow',
      handler: getCashFlowReport,
      summary: 'Get cash flow trend',
      description: 'Returns monthly income, expenses, and net profit trend',
      authRoles: permissions.transactions.list,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            months: { type: 'integer', default: 6, maximum: 12, description: 'Number of months to include' },
          },
        },
      },
    },
  ],

  events: events,
});

export default transactionResource;
