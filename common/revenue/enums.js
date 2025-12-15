/**
 * Shared Revenue Enums
 * Single source of truth for all revenue-related enums across the application
 * 
 * This file re-exports enums from @classytic/revenue and defines app-specific enums
 * 
 * Usage:
 * ```javascript
 * import { SUBSCRIPTION_STATUS, PAYMENT_METHOD } from '#common/revenue/enums.js';
 * ```
 */

// ============ RE-EXPORT @CLASSYTIC/REVENUE ENUMS ============

export {
  // Monetization types (subscription/purchase/free)
  MONETIZATION_TYPES,
  MONETIZATION_TYPE_VALUES,

  // Subscription status (active/paused/cancelled/expired/pending/inactive)
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,

  // Payment status (pending/completed/failed/refunded/cancelled)
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,

  // Transaction status
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,

  // Transaction type (income/expense)
  TRANSACTION_TYPE,
  TRANSACTION_TYPE_VALUES,

  // Payment gateway types (manual/stripe/sslcommerz/bkash/nagad)
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  GATEWAY_TYPES,
  GATEWAY_TYPE_VALUES,

  // Subscription plan keys (monthly/quarterly/yearly)
  PLAN_KEYS,
  PLAN_KEY_VALUES,

  // Library-defined transaction categories
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,
} from '@classytic/revenue';

// ============ APP-SPECIFIC ENUMS ============

/**
 * Payment Methods (App-specific)
 * Defines the payment methods available in Bangladesh
 */
export const PAYMENT_METHOD = {
  BKASH: 'bkash',
  NAGAD: 'nagad',
  ROCKET: 'rocket',
  BANK: 'bank',
  CARD: 'card',
  ONLINE: 'online',
  CASH: 'cash',
};

export const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHOD);

/**
 * Transaction Categories (App-specific)
 * Maps to revenue package categoryMappings in bootstrap/revenue.js
 */
export const TRANSACTION_CATEGORY = {
  PLATFORM_SUBSCRIPTION: 'platform_subscription',
  CREATOR_SUBSCRIPTION: 'creator_subscription',
  ORDER_PURCHASE: 'order_purchase',
  ORDER_SUBSCRIPTION: 'order_subscription',
  ENROLLMENT_PURCHASE: 'enrollment_purchase',
  ENROLLMENT_SUBSCRIPTION: 'enrollment_subscription',
};

export const TRANSACTION_CATEGORY_VALUES = Object.values(TRANSACTION_CATEGORY);

// ============ DEFAULT EXPORT ============

import {
  MONETIZATION_TYPES,
  MONETIZATION_TYPE_VALUES,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,
  TRANSACTION_TYPE,
  TRANSACTION_TYPE_VALUES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  GATEWAY_TYPES,
  GATEWAY_TYPE_VALUES,
  PLAN_KEYS,
  PLAN_KEY_VALUES,
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,
} from '@classytic/revenue';

export default {
  // Revenue library enums
  MONETIZATION_TYPES,
  MONETIZATION_TYPE_VALUES,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,
  TRANSACTION_TYPE,
  TRANSACTION_TYPE_VALUES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  GATEWAY_TYPES,
  GATEWAY_TYPE_VALUES,
  PLAN_KEYS,
  PLAN_KEY_VALUES,
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,

  // App-specific enums
  PAYMENT_METHOD,
  PAYMENT_METHOD_VALUES,
  TRANSACTION_CATEGORY,
  TRANSACTION_CATEGORY_VALUES,
};

