/**
 * Financial Reports Handlers
 * Provides financial insights for ecommerce admin
 * 
 * Single-tenant - no organizationId needed
 */

import {
  getFinancialReport,
  getCategoryBreakdown,
  getCashFlowTrend,
} from '../workflows/financial-reports.workflow.js';

/**
 * Get P&L Report Handler
 * GET /transactions/reports/profit-loss
 *
 * Query params:
 * - startDate: Start date (ISO 8601)
 * - endDate: End date (ISO 8601)
 */
export async function getProfitLossReport(request, reply) {
  try {
    const { startDate, endDate } = request.query;

    const report = await getFinancialReport({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    return reply.send({
      success: true,
      data: report,
    });
  } catch (error) {
    request.log.error('Get P&L report error:', error);
    return reply.code(400).send({
      success: false,
      message: error.message || 'Failed to generate report',
    });
  }
}

/**
 * Get Category Breakdown Handler
 * GET /transactions/reports/categories
 *
 * Query params:
 * - startDate: Start date (ISO 8601)
 * - endDate: End date (ISO 8601)
 * - type: 'income' or 'expense' (optional)
 * - limit: Number of categories (default: 10)
 */
export async function getCategoriesReport(request, reply) {
  try {
    const { startDate, endDate, type, limit } = request.query;

    const breakdown = await getCategoryBreakdown({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      type,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return reply.send({
      success: true,
      data: breakdown,
    });
  } catch (error) {
    request.log.error('Get category breakdown error:', error);
    return reply.code(400).send({
      success: false,
      message: error.message || 'Failed to generate breakdown',
    });
  }
}

/**
 * Get Cash Flow Trend Handler
 * GET /transactions/reports/cash-flow
 *
 * Query params:
 * - months: Number of months (default: 6, max: 12)
 */
export async function getCashFlowReport(request, reply) {
  try {
    const { months } = request.query;

    const trend = await getCashFlowTrend({
      months: months ? parseInt(months, 10) : undefined,
    });

    return reply.send({
      success: true,
      data: trend,
    });
  } catch (error) {
    request.log.error('Get cash flow trend error:', error);
    return reply.code(400).send({
      success: false,
      message: error.message || 'Failed to generate cash flow trend',
    });
  }
}

export default {
  getProfitLossReport,
  getCategoriesReport,
  getCashFlowReport,
};
