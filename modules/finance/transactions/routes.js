import fp from 'fastify-plugin';
import createCrudRouter from '#core/factories/createCrudRouter.js';
import transactionSchemas from './schemas.js';
import permissions from '#config/permissions.js';
import {
  getProfitLossReport,
  getCategoriesReport,
  getCashFlowReport,
} from './handlers/reports.handler.js';
import { getStatement } from './handlers/statement.handler.js';
import controller from './transaction.controller.js';

/**
 * Transaction Plugin - Payment & Revenue System
 *
 * Transaction Creation (Automatic via @classytic/revenue):
 * - Order purchases → createOrderWorkflow → revenue.monetization.create()
 * - Refunds → refundOrderWorkflow → revenue.payments.refund()
 *
 * Payment Verification:
 * - POST /webhooks/payments/manual/verify → revenue.payments.verify()
 *   - Triggers 'payment.verified' hook → Updates order status
 *
 * Financial Reports:
 * - GET /transactions/reports/profit-loss → P&L statement
 * - GET /transactions/reports/categories → Category breakdown
 * - GET /transactions/reports/cash-flow → Monthly trend
 *
 * Security:
 * - All transactions are created by revenue library (no manual creation)
 * - Admin-only access for viewing and reports
 */
async function transactionPlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, controller, {
      tag: 'Transaction',
      schemas: transactionSchemas,
      auth: permissions.transactions,
      additionalRoutes: [
        // Statement export (accounting-friendly)
        {
          method: 'get',
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
          method: 'get',
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
          method: 'get',
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
          method: 'get',
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
    });
  }, { prefix: '/transactions' });
}

export default fp(transactionPlugin, { name: 'transaction-plugin' });
