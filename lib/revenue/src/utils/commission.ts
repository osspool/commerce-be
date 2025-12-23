/**
 * Commission Calculation Utility
 * @classytic/revenue
 *
 * Handles platform commission calculation with gateway fee deduction
 */

import type { CommissionInfo } from '../types/index.js';

/**
 * Build commission object for transaction
 *
 * @param amount - Transaction amount
 * @param commissionRate - Commission rate (0 to 1, e.g., 0.10 for 10%)
 * @param gatewayFeeRate - Gateway fee rate (0 to 1, e.g., 0.018 for 1.8%)
 * @returns Commission object or null
 */
export function calculateCommission(
  amount: number,
  commissionRate: number,
  gatewayFeeRate: number = 0
): CommissionInfo | null {
  // No commission if rate is 0 or negative
  if (!commissionRate || commissionRate <= 0) {
    return null;
  }

  // Validate inputs
  if (amount < 0) {
    throw new Error('Transaction amount cannot be negative');
  }

  if (commissionRate < 0 || commissionRate > 1) {
    throw new Error('Commission rate must be between 0 and 1');
  }

  if (gatewayFeeRate < 0 || gatewayFeeRate > 1) {
    throw new Error('Gateway fee rate must be between 0 and 1');
  }

  // Calculate commission
  const grossAmount = Math.round(amount * commissionRate * 100) / 100; // Round to 2 decimals
  const gatewayFeeAmount = Math.round(amount * gatewayFeeRate * 100) / 100;
  const netAmount = Math.max(0, Math.round((grossAmount - gatewayFeeAmount) * 100) / 100);

  return {
    rate: commissionRate,
    grossAmount,
    gatewayFeeRate,
    gatewayFeeAmount,
    netAmount,
    status: 'pending',
  };
}

/**
 * Reverse commission on refund (proportional)
 *
 * @param originalCommission - Original commission object
 * @param originalAmount - Original transaction amount
 * @param refundAmount - Amount being refunded
 * @returns Reversed commission or null
 */
export function reverseCommission(
  originalCommission: CommissionInfo | null | undefined,
  originalAmount: number,
  refundAmount: number
): CommissionInfo | null {
  if (!originalCommission?.netAmount) {
    return null;
  }

  // Calculate proportional refund
  const refundRatio = refundAmount / originalAmount;
  const reversedNetAmount = Math.round(originalCommission.netAmount * refundRatio * 100) / 100;
  const reversedGrossAmount = Math.round(originalCommission.grossAmount * refundRatio * 100) / 100;
  const reversedGatewayFee = Math.round(originalCommission.gatewayFeeAmount * refundRatio * 100) / 100;

  return {
    rate: originalCommission.rate,
    grossAmount: reversedGrossAmount,
    gatewayFeeRate: originalCommission.gatewayFeeRate,
    gatewayFeeAmount: reversedGatewayFee,
    netAmount: reversedNetAmount,
    status: 'waived', // Commission waived due to refund
  };
}

export default {
  calculateCommission,
  reverseCommission,
};

