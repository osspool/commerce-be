/**
 * Financial Reports Workflow
 * Simplified for ecommerce (order purchases and refunds only)
 *
 * Provides:
 * - Profit & Loss (P&L) statement
 * - Inflow/Outflow breakdown
 * - Cash flow summary
 */

import Transaction from '../transaction.model.js';
import { TRANSACTION_FLOW } from '@classytic/revenue/enums';

interface FinancialReportParams {
  startDate?: Date;
  endDate?: Date;
}

interface CategoryBreakdownParams {
  startDate?: Date;
  endDate?: Date;
  flow?: string;
  limit?: number;
}

interface CashFlowTrendParams {
  months?: number;
}

interface CategoryEntry {
  total: number;
  count: number;
  label: string;
}

interface AggGroupResult {
  _id: { flow: string; type: string } | string;
  total: number;
  count: number;
}

interface MonthlyAggResult {
  _id: { year: number; month: number; flow: string };
  total: number;
}

/**
 * Get financial report for date range
 */
export async function getFinancialReport({ startDate, endDate }: FinancialReportParams) {
  // Default date range: last 30 days
  let resolvedEndDate = endDate;
  let resolvedStartDate = startDate;

  if (!resolvedEndDate) {
    resolvedEndDate = new Date();
  }

  if (!resolvedStartDate) {
    resolvedStartDate = new Date();
    resolvedStartDate.setDate(resolvedStartDate.getDate() - 30);
  }

  // Validate date range (max 1 year)
  const daysDiff = (resolvedEndDate.getTime() - resolvedStartDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff > 365) {
    throw new Error('Date range cannot exceed 1 year');
  }

  // Get all verified transactions in date range
  const transactions = await Transaction.aggregate([
    {
      $match: {
        createdAt: { $gte: resolvedStartDate, $lte: resolvedEndDate },
        status: { $in: ['verified', 'completed'] },
      },
    },
    {
      $group: {
        _id: {
          flow: '$flow',
          type: '$type',
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  // Separate inflows and outflows
  const inflowByCategory: Record<string, CategoryEntry> = {};
  const outflowByCategory: Record<string, CategoryEntry> = {};

  let totalInflow = 0;
  let totalOutflow = 0;

  (transactions as AggGroupResult[]).forEach((item) => {
    const id = item._id as { flow: string; type: string };
    const { flow, type } = id;
    const amount = item.total;

    if (flow === TRANSACTION_FLOW.INFLOW) {
      inflowByCategory[type] = {
        total: amount,
        count: item.count,
        label: getCategoryLabel(type),
      };
      totalInflow += amount;
    } else if (flow === TRANSACTION_FLOW.OUTFLOW) {
      outflowByCategory[type] = {
        total: amount,
        count: item.count,
        label: getCategoryLabel(type),
      };
      totalOutflow += amount;
    }
  });

  // Calculate profit/loss
  const netProfit = totalInflow - totalOutflow;
  const profitMargin = totalInflow > 0 ? (netProfit / totalInflow) * 100 : 0;

  return {
    period: {
      startDate: resolvedStartDate,
      endDate: resolvedEndDate,
      days: Math.ceil(daysDiff),
    },
    summary: {
      totalIncome: totalInflow,
      totalExpenses: totalOutflow,
      netProfit,
      profitMargin: Math.round(profitMargin * 100) / 100,
    },
    income: {
      total: totalInflow,
      breakdown: inflowByCategory,
    },
    expenses: {
      total: totalOutflow,
      breakdown: outflowByCategory,
    },
  };
}

/**
 * Get category breakdown (top categories)
 */
export async function getCategoryBreakdown({ startDate, endDate, flow, limit = 10 }: CategoryBreakdownParams) {
  const matchQuery: Record<string, unknown> = {
    status: { $in: ['verified', 'completed'] },
  };

  if (startDate && endDate) {
    matchQuery.createdAt = { $gte: startDate, $lte: endDate };
  }

  if (flow) {
    matchQuery.flow = flow;
  }

  const breakdown = await Transaction.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
    { $limit: limit },
  ]);

  return (breakdown as Array<{ _id: string; total: number; count: number }>).map((item) => ({
    category: item._id,
    label: getCategoryLabel(item._id),
    total: item.total,
    count: item.count,
  }));
}

/**
 * Get cash flow trend (monthly)
 */
export async function getCashFlowTrend({ months = 6 }: CashFlowTrendParams) {
  if (months > 12) {
    throw new Error('Months cannot exceed 12');
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const trend = await Transaction.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
        status: { $in: ['verified', 'completed'] },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          flow: '$flow',
        },
        total: { $sum: '$amount' },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  // Group by month
  const monthlyData = new Map<
    string,
    { year: number; month: number; monthName: string; income: number; expenses: number }
  >();

  (trend as MonthlyAggResult[]).forEach((item) => {
    const key = `${item._id.year}-${item._id.month}`;

    if (!monthlyData.has(key)) {
      monthlyData.set(key, {
        year: item._id.year,
        month: item._id.month,
        monthName: getMonthName(item._id.month),
        income: 0,
        expenses: 0,
      });
    }

    const data = monthlyData.get(key)!;
    if (item._id.flow === TRANSACTION_FLOW.INFLOW) {
      data.income += item.total;
    } else if (item._id.flow === TRANSACTION_FLOW.OUTFLOW) {
      data.expenses += item.total;
    }
  });

  return Array.from(monthlyData.values()).map((item) => ({
    ...item,
    netProfit: item.income - item.expenses,
  }));
}

/**
 * Helper: Get human-readable category label
 */
function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    // Revenue library categories
    subscription: 'Subscriptions',
    purchase: 'Purchases',

    // Ecommerce categories
    order_purchase: 'Order Sales',
    order_subscription: 'Subscription Orders',

    // Other
    refund: 'Refunds',
    other_income: 'Other Income',
    other_expense: 'Other Expenses',
  };

  return labels[category] || category;
}

/**
 * Helper: Get month name
 */
function getMonthName(month: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[month - 1];
}

export default {
  getFinancialReport,
  getCategoryBreakdown,
  getCashFlowTrend,
};
