/**
 * Shared Revenue Enums
 * Single source of truth for all revenue-related enums across the application
 * 
 * This file re-exports enums from @classytic/revenue and defines app-specific enums
 * 
 * Usage:
 * ```javascript
 * import { SUBSCRIPTION_STATUS, PAYMENT_METHOD } from '#shared/revenue/enums.js';
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

  // Transaction flow (inflow/outflow) - direction of money
  TRANSACTION_FLOW,
  TRANSACTION_FLOW_VALUES,

  // @deprecated Use TRANSACTION_FLOW instead - kept for backward compatibility
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
} from '@classytic/revenue/enums';

// ============ APP-SPECIFIC ENUMS ============

/**
 * Payment Methods (App-specific)
 * Defines the payment methods available in Bangladesh
 *
 * Note: Use same values as order.enums.js PAYMENT_METHODS for consistency
 */
export const PAYMENT_METHOD = {
  CASH: 'cash',
  BKASH: 'bkash',
  NAGAD: 'nagad',
  ROCKET: 'rocket',
  BANK_TRANSFER: 'bank_transfer',
  CARD: 'card',
  ONLINE: 'online',
};

export const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHOD);

/**
 * Transaction Categories (App-specific)
 * Maps to revenue package categoryMappings in bootstrap/revenue.js
 *
 * Categories:
 * - Sales/Revenue: ORDER_*, ENROLLMENT_*, *_SUBSCRIPTION
 * - Inventory: INVENTORY_* (user-triggered only, see inventory-management.plugin.js)
 * - COGS: Cost of goods sold (optional, at fulfillment)
 *
 * Industry Standard Categories (inspired by AWS/GCP accounting):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ INCOME                          │ EXPENSE                       │
 * ├─────────────────────────────────┼───────────────────────────────┤
 * │ order_purchase (POS/Web sales)  │ inventory_purchase (stock)    │
 * │ wholesale_sale (B2B sales)      │ purchase_return (refund recv) │
 * │ capital_injection               │ cogs (cost of goods sold)     │
 * │ retained_earnings               │ rent, utilities, equipment... │
 * │ other_income                    │ inventory_loss                │
 * │ tip_income (optional)           │ marketing, maintenance...     │
 * └─────────────────────────────────┴───────────────────────────────┘
 */
export const TRANSACTION_CATEGORY = {
  // ============ REVENUE CATEGORIES ============
  // Sales from customers (POS + Web)
  ORDER_PURCHASE: 'order_purchase',
  ORDER_SUBSCRIPTION: 'order_subscription',

  // B2B / Wholesale sales (optional - for businesses selling to other retailers)
  WHOLESALE_SALE: 'wholesale_sale',

  // Platform/Creator subscriptions
  PLATFORM_SUBSCRIPTION: 'platform_subscription',
  CREATOR_SUBSCRIPTION: 'creator_subscription',

  // Course/Enrollment sales
  ENROLLMENT_PURCHASE: 'enrollment_purchase',
  ENROLLMENT_SUBSCRIPTION: 'enrollment_subscription',

  // ============ INVENTORY CATEGORIES ============
  // Stock purchases from suppliers (expense - actual money out)
  INVENTORY_PURCHASE: 'inventory_purchase',

  // Supplier returns - credit received for returned stock (income)
  PURCHASE_RETURN: 'purchase_return',

  // Stock loss - damaged/lost/expired (expense)
  INVENTORY_LOSS: 'inventory_loss',

  // Stock adjustments - corrections (±)
  INVENTORY_ADJUSTMENT: 'inventory_adjustment',

  // Cost of goods sold - recorded at fulfillment (expense, optional)
  COGS: 'cogs',

  // ============ OPERATIONAL EXPENSES ============
  RENT: 'rent',
  UTILITIES: 'utilities',
  EQUIPMENT: 'equipment',
  SUPPLIES: 'supplies',
  MAINTENANCE: 'maintenance',
  MARKETING: 'marketing',
  OTHER_EXPENSE: 'other_expense',

  // ============ OPERATIONAL INCOME ============
  CAPITAL_INJECTION: 'capital_injection',
  RETAINED_EARNINGS: 'retained_earnings',
  TIP_INCOME: 'tip_income',           // Tips from customers (optional)
  OTHER_INCOME: 'other_income',
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
  TRANSACTION_FLOW,
  TRANSACTION_FLOW_VALUES,
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
} from '@classytic/revenue/enums';

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
  TRANSACTION_FLOW,
  TRANSACTION_FLOW_VALUES,
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

