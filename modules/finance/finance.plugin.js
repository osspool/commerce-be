import { createRoutes } from '#core/factories/createRoutes.js';
import permissions from '#config/permissions.js';
import { getStatement } from '#modules/transaction/handlers/statement.handler.js';
import { getFinanceSummary } from './handlers/summary.handler.js';

/**
 * Finance Module (Backoffice)
 *
 * Purpose:
 * - A stable, manageable surface for finance/backoffice UIs
 * - Exports accountant-friendly statements (Excel/Tally workflows)
 *
 * Note:
 * - Finance reads from transactions (source of truth for payments).
 * - Inventory/COGS is handled in commerce modules; finance exports focus on cashflow.
 */
async function financePlugin(fastify) {
  createRoutes(
    fastify,
    [
      {
        method: 'GET',
        url: '/finance/summary',
        summary: 'Finance dashboard summary (BD day + branch)',
        description: 'Aggregates income/expense/net by BD day, branch, and payment method.',
        authRoles: permissions.finance.any,
        handler: getFinanceSummary,
      },
      {
        method: 'GET',
        url: '/finance/statements',
        summary: 'Export finance statement (CSV/JSON)',
        description: 'Wrapper around transactions statement export, for finance backoffice.',
        authRoles: permissions.finance.any,
        handler: getStatement,
      },
    ],
    { tag: 'Finance' }
  );
}

export default financePlugin;
