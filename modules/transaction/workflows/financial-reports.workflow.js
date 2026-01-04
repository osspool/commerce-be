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

/**
 * Get financial report for date range
 *
 * @param {Object} params
 * @param {Date} params.startDate - Start date (default: 30 days ago)
 * @param {Date} params.endDate - End date (default: now)
 * @returns {Promise<Object>} Financial report
 */
export async function getFinancialReport({ startDate, endDate }) {
  // Default date range: last 30 days
  if (!endDate) {
    endDate = new Date();
  }

  if (!startDate) {
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
  }

  // Validate date range (max 1 year)
  const daysDiff = (endDate - startDate) / (1000 * 60 * 60 * 24);
  if (daysDiff > 365) {
    throw new Error('Date range cannot exceed 1 year');
  }

  // Get all verified transactions in date range
  const transactions = await Transaction.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate, $lte: endDate },
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
  const inflowByCategory = {};
  const outflowByCategory = {};

  let totalInflow = 0;
  let totalOutflow = 0;

  transactions.forEach((item) => {
    const { flow, type } = item._id;
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
      startDate,
      endDate,
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
 *
 * @param {Object} params
 * @param {Date} params.startDate - Start date
 * @param {Date} params.endDate - End date
 * @param {String} params.flow - 'inflow' or 'outflow' (optional)
 * @param {Number} params.limit - Number of categories to return (default: 10)
 * @returns {Promise<Array>} Category breakdown
 */
export async function getCategoryBreakdown({
  startDate,
  endDate,
  flow,
  limit = 10,
}) {
  const matchQuery = {
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

  return breakdown.map((item) => ({
    category: item._id,
    label: getCategoryLabel(item._id),
    total: item.total,
    count: item.count,
  }));
}

/**
 * Get cash flow trend (monthly)
 *
 * @param {Object} params
 * @param {Number} params.months - Number of months to include (default: 6, max: 12)
 * @returns {Promise<Array>} Monthly cash flow data
 */
export async function getCashFlowTrend({ months = 6 }) {
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
  const monthlyData = new Map();

  trend.forEach((item) => {
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

    const data = monthlyData.get(key);
    if (item._id.flow === TRANSACTION_FLOW.INFLOW) {
      data.income += item.total;
    } else if (item._id.flow === TRANSACTION_FLOW.OUTFLOW) {
      data.expenses += item.total;
    }
  });

  return Array.from(monthlyData.values()).map(item => ({
    ...item,
    netProfit: item.income - item.expenses,
  }));
}

/**
 * Helper: Get human-readable category label
 */
function getCategoryLabel(category) {
  const labels = {
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
function getMonthName(month) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return months[month - 1];
}

export default {
  getFinancialReport,
  getCategoryBreakdown,
  getCashFlowTrend,
};
