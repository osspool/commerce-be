/**
 * Shared Revenue Schemas
 * Single source of truth for all revenue-related schemas across the application
 * 
 * This file re-exports schemas from @classytic/revenue and defines app-specific schemas
 * 
 * Usage in Models:
 * ```javascript
 * import { subscriptionInfoSchema, currentPaymentSchema } from '#shared/revenue/schemas.js';
 * 
 * const mySchema = new Schema({
 *   subscription: { type: subscriptionInfoSchema },
 *   currentPayment: { type: currentPaymentSchema },
 * });
 * ```
 * 
 * Usage in API Schemas:
 * ```javascript
 * import { paymentDataSchema } from '#shared/revenue/schemas.js';
 * 
 * const createBody = {
 *   properties: {
 *     paymentData: paymentDataSchema,
 *   }
 * };
 * ```
 */

// ============ RE-EXPORT @CLASSYTIC/REVENUE SCHEMAS ============

// Subscription schemas (for Mongoose models)
export {
  planSchema,
  subscriptionInfoSchema,
} from '@classytic/revenue/schemas';

// Payment/Transaction schemas (for Mongoose models)
export {
  paymentEntrySchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,
} from '@classytic/revenue/schemas';

// ============ VALIDATION HELPERS ============

/**
 * Validates that split payment totals match the transaction amount
 * Returns true for single payments (no payments array)
 *
 * @param {Object} currentPayment - The current payment object to validate
 * @returns {boolean} true if valid, false if split totals don't match
 */
export function validateSplitPayments(currentPayment) {
  if (!currentPayment.payments?.length) {
    return true; // Single payment, no validation needed
  }

  const paymentsTotal = currentPayment.payments.reduce(
    (sum, p) => sum + p.amount,
    0
  );

  return paymentsTotal === currentPayment.amount;
}

// ============ APP-SPECIFIC API SCHEMAS ============

import { PAYMENT_METHOD_VALUES } from './enums.js';
import { PAYMENT_GATEWAY_TYPE_VALUES, PLAN_KEY_VALUES } from '@classytic/revenue/enums';

/**
 * Payment Data Schema (for API requests)
 * Used when creating subscriptions/purchases that require payment
 */
export const paymentDataSchema = {
  type: 'object',
  description: 'Payment details (required for paid items)',
  required: ['method'],
  properties: {
    method: {
      type: 'string',
      enum: PAYMENT_METHOD_VALUES,
      description: 'Payment method',
    },
    gateway: {
      type: 'string',
      enum: PAYMENT_GATEWAY_TYPE_VALUES,
      default: 'manual',
      description: 'Payment gateway type',
    },
    reference: {
      type: 'string',
      minLength: 5,
      description: 'Transaction ID (required for manual payments)',
    },
    paymentDetails: {
      type: 'object',
      description: 'Additional payment details (for manual verification)',
      properties: {
        walletNumber: { type: 'string' },
        walletType: { type: 'string', enum: ['personal', 'merchant'] },
        bankName: { type: 'string' },
        accountNumber: { type: 'string' },
        accountName: { type: 'string' },
        proofUrl: { type: 'string', format: 'uri' },
      },
    },
    notes: {
      type: 'string',
      maxLength: 500,
    },
    returnUrl: {
      type: 'string',
      format: 'uri',
    },
    cancelUrl: {
      type: 'string',
      format: 'uri',
    },
  },
};

/**
 * Plan Key Schema (for API requests)
 * Used for plan selection in subscription creation
 */
export const planKeySchema = {
  type: 'string',
  enum: PLAN_KEY_VALUES,
  description: 'Subscription plan key (monthly/quarterly/yearly)',
};

/**
 * Plan Object Schema (for API requests)
 * Used when creating subscriptions
 */
export const planObjectSchema = {
  type: 'object',
  required: ['key'],
  properties: {
    key: planKeySchema,
    price: {
      type: 'number',
      minimum: 0,
      description: 'Plan price (optional - backend validates or auto-fills)',
    },
  },
};

// ============ HELPER FUNCTIONS ============

/**
 * Build currentPayment object (single payment)
 * @param {number} amount - Payment amount
 * @param {string} method - Payment method
 * @param {string} reference - Payment reference (optional)
 * @returns {Object}
 */
export function buildCurrentPayment(amount, method, reference = null) {
  return {
    amount,
    status: 'pending',
    method,
    reference,
  };
}

/**
 * Build currentPayment object with split payments support
 * @param {number} totalAmount - Total payment amount
 * @param {Array<{method: string, amount: number, reference?: string, details?: object}>} payments - Payment entries
 * @returns {Object}
 */
export function buildSplitPayment(totalAmount, payments) {
  if (!payments || payments.length === 0) {
    throw new Error('At least one payment entry is required');
  }

  if (payments.length === 1) {
    // Single payment - use standard format
    return {
      amount: totalAmount,
      status: 'pending',
      method: payments[0].method,
      reference: payments[0].reference || null,
    };
  }

  // Multiple payments - use split format
  return {
    amount: totalAmount,
    status: 'pending',
    method: 'split',
    payments: payments.map(p => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference || null,
      details: p.details || null,
    })),
  };
}

// ============ DEFAULT EXPORT ============

// Import re-exported schemas for default export
import {
  planSchema,
  subscriptionInfoSchema,
  paymentEntrySchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,
} from '@classytic/revenue/schemas';

export default {
  // Mongoose schemas
  planSchema,
  subscriptionInfoSchema,
  paymentEntrySchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,

  // API schemas
  paymentDataSchema,
  planKeySchema,
  planObjectSchema,

  // Helpers
  buildCurrentPayment,
  buildSplitPayment,
  validateSplitPayments,
};

