/**
 * Financial Reports Handlers
 * Provides financial insights for ecommerce admin
 *
 * Single-tenant - no organizationId needed
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getFinancialReport, getCategoryBreakdown, getCashFlowTrend } from '../workflows/financial-reports.workflow.js';

interface ProfitLossQuery {
  startDate?: string;
  endDate?: string;
}

interface CategoriesQuery {
  startDate?: string;
  endDate?: string;
  type?: string;
  limit?: string;
}

interface CashFlowQuery {
  months?: string;
}

/**
 * Get P&L Report Handler
 * GET /transactions/reports/profit-loss
 */
export async function getProfitLossReport(
  request: FastifyRequest<{ Querystring: ProfitLossQuery }>,
  reply: FastifyReply,
): Promise<void> {
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
    const err = error as Error;
    request.log.error({ err }, 'Get P&L report error');
    return reply.code(400).send({
      success: false,
      message: err.message || 'Failed to generate report',
    });
  }
}

/**
 * Get Category Breakdown Handler
 * GET /transactions/reports/categories
 */
export async function getCategoriesReport(
  request: FastifyRequest<{ Querystring: CategoriesQuery }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const { startDate, endDate, type, limit } = request.query;

    const breakdown = await getCategoryBreakdown({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      flow: type,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return reply.send({
      success: true,
      data: breakdown,
    });
  } catch (error) {
    const err = error as Error;
    request.log.error({ err }, 'Get category breakdown error');
    return reply.code(400).send({
      success: false,
      message: err.message || 'Failed to generate breakdown',
    });
  }
}

/**
 * Get Cash Flow Trend Handler
 * GET /transactions/reports/cash-flow
 */
export async function getCashFlowReport(
  request: FastifyRequest<{ Querystring: CashFlowQuery }>,
  reply: FastifyReply,
): Promise<void> {
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
    const err = error as Error;
    request.log.error({ err }, 'Get cash flow trend error');
    return reply.code(400).send({
      success: false,
      message: err.message || 'Failed to generate cash flow trend',
    });
  }
}

export default {
  getProfitLossReport,
  getCategoriesReport,
  getCashFlowReport,
};
