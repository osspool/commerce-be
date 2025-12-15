/**
 * Shared Revenue Schemas
 * Single source of truth for all revenue-related schemas across the application
 * 
 * This file re-exports schemas from @classytic/revenue and defines app-specific schemas
 * 
 * Usage in Models:
 * ```javascript
 * import { subscriptionInfoSchema, currentPaymentSchema } from '#common/revenue/schemas.js';
 * 
 * const mySchema = new Schema({
 *   subscription: { type: subscriptionInfoSchema },
 *   currentPayment: { type: currentPaymentSchema },
 * });
 * ```
 * 
 * Usage in API Schemas:
 * ```javascript
 * import { paymentDataSchema } from '#common/revenue/schemas.js';
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
  subscriptionPlanSchema,
  subscriptionInfoSchema,
} from '@classytic/revenue/schemas';

// Payment/Transaction schemas (for Mongoose models)
export {
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,
} from '@classytic/revenue/schemas';

// Common fields
export {
  commonFields,
} from '@classytic/revenue/schemas';

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
 * Build currentPayment object
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

// ============ DEFAULT EXPORT ============

// Import re-exported schemas for default export
import {
  subscriptionPlanSchema,
  subscriptionInfoSchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,
  commonFields,
} from '@classytic/revenue/schemas';

export default {
  // Mongoose schemas
  subscriptionPlanSchema,
  subscriptionInfoSchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
  gatewaySchema,
  commissionSchema,
  commonFields,

  // API schemas
  paymentDataSchema,
  planKeySchema,
  planObjectSchema,

  // Helpers
  buildCurrentPayment,
};

