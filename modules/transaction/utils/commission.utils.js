/**
 * Commission CRUD Operations
 * Database operations for commission management
 */

import Transaction from '../transaction.model.js';

/**
 * Calculate commission amounts
 * @param {Number} amount - Transaction amount
 * @param {Number} commissionRate - Commission rate (0-1, e.g., 0.05 for 5%)
 * @param {Number} gatewayFeeRate - Gateway fee rate (0-1)
 * @returns {Object} - Commission breakdown
 */
export function calculateCommission(amount, commissionRate = 0, gatewayFeeRate = 0) {
  const grossAmount = amount * commissionRate;
  const gatewayFeeAmount = amount * gatewayFeeRate;
  const netAmount = grossAmount - gatewayFeeAmount;

  return {
    grossAmount: Math.round(grossAmount * 100) / 100,
    gatewayFeeAmount: Math.round(gatewayFeeAmount * 100) / 100,
    netAmount: Math.round(netAmount * 100) / 100,
  };
}

/**
 * Build commission object for transaction
 * @param {Number} amount - Transaction amount
 * @param {Number} rate - Commission rate
 * @param {Number} gatewayFeeRate - Gateway fee rate
 * @param {Date} dueDate - When commission is due
 * @returns {Object} - Commission object
 */
export function buildCommissionObject(amount, rate, gatewayFeeRate = 0, dueDate = null) {
  const calc = calculateCommission(amount, rate, gatewayFeeRate);

  return {
    rate,
    ...calc,
    gatewayFeeRate,
    status: 'pending',
    dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  };
}

/**
 * Mark commission as due (after customer payment verified)
 */
export async function markCommissionDue(transactionId, session = null) {
  return Transaction.findByIdAndUpdate(
    transactionId,
    {
      $set: {
        'commission.status': 'due',
      }
    },
    { new: true, session }
  ).exec();
}

/**
 * Mark commission as paid by organization
 */
export async function markCommissionPaid(transactionId, paidBy, notes = '', session = null) {
  return Transaction.findByIdAndUpdate(
    transactionId,
    {
      $set: {
        'commission.status': 'paid',
        'commission.paidDate': new Date(),
        'commission.paidBy': paidBy,
        'commission.notes': notes,
      }
    },
    { new: true, session }
  ).exec();
}

/**
 * Waive commission (platform decides not to charge)
 */
export async function waiveCommission(transactionId, reason = '', session = null) {
  return Transaction.findByIdAndUpdate(
    transactionId,
    {
      $set: {
        'commission.status': 'waived',
        'commission.notes': reason,
      }
    },
    { new: true, session }
  ).exec();
}

/**
 * Get all due commissions for an organization
 */
export async function getDueCommissions(organizationId, options = {}) {
  const query = {
    organizationId,
    'commission.status': 'due',
  };

  // Filter by overdue
  if (options.overdue) {
    query['commission.dueDate'] = { $lt: new Date() };
  }

  return Transaction.find(query)
    .sort({ 'commission.dueDate': 1 })
    .select('amount commission category referenceModel referenceId date')
    .limit(options.limit || 100)
    .lean()
    .exec();
}

/**
 * Get commission summary for organization
 * Returns gross, gateway fees, and net amounts
 */
export async function getCommissionSummary(organizationId) {
  const result = await Transaction.aggregate([
    {
      $match: {
        organizationId,
        'commission.grossAmount': { $exists: true, $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$commission.status',
        grossAmount: { $sum: '$commission.grossAmount' },
        gatewayFees: { $sum: '$commission.gatewayFeeAmount' },
        netAmount: { $sum: '$commission.netAmount' },
        count: { $sum: 1 }
      }
    }
  ]).exec();

  // Convert to object with breakdown
  const summary = {
    pending: { grossAmount: 0, gatewayFees: 0, netAmount: 0, count: 0 },
    due: { grossAmount: 0, gatewayFees: 0, netAmount: 0, count: 0 },
    paid: { grossAmount: 0, gatewayFees: 0, netAmount: 0, count: 0 },
    waived: { grossAmount: 0, gatewayFees: 0, netAmount: 0, count: 0 },
    total: { grossAmount: 0, gatewayFees: 0, netAmount: 0, count: 0 }
  };

  result.forEach(item => {
    if (item._id) {
      summary[item._id] = {
        grossAmount: item.grossAmount,
        gatewayFees: item.gatewayFees,
        netAmount: item.netAmount,
        count: item.count
      };
    }
    summary.total.grossAmount += item.grossAmount;
    summary.total.gatewayFees += item.gatewayFees;
    summary.total.netAmount += item.netAmount;
    summary.total.count += item.count;
  });

  return summary;
}

export default {
  markCommissionDue,
  markCommissionPaid,
  waiveCommission,
  getDueCommissions,
  getCommissionSummary
};

