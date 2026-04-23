/**
 * Shared Revenue Enums
 * Single source of truth for all revenue-related enums across the application
 *
 * Re-exports enums from @classytic/revenue v2 and defines app-specific enums.
 *
 * v1 → v2 changes:
 *   - TRANSACTION_TYPE removed (was deprecated alias for TRANSACTION_FLOW). Use TRANSACTION_FLOW.
 *   - GATEWAY_TYPES removed (merged into PAYMENT_GATEWAY_TYPE). Use PAYMENT_GATEWAY_TYPE.
 */

export {
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,
  MONETIZATION_TYPE_VALUES,
  MONETIZATION_TYPES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PLAN_KEY_VALUES,
  PLAN_KEYS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  TRANSACTION_FLOW,
  TRANSACTION_FLOW_VALUES,
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,
} from '@classytic/revenue/enums';

// ============ APP-SPECIFIC ENUMS ============

export const PAYMENT_METHOD = {
  CASH: 'cash',
  BKASH: 'bkash',
  NAGAD: 'nagad',
  ROCKET: 'rocket',
  BANK_TRANSFER: 'bank_transfer',
  CARD: 'card',
  ONLINE: 'online',
} as const;

export type PaymentMethodValue = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];
export const PAYMENT_METHOD_VALUES: string[] = Object.values(PAYMENT_METHOD);

/**
 * Transaction Categories (App-specific)
 * Used as the `type` field on transactions for reporting / ledger routing.
 */
export const TRANSACTION_CATEGORY = {
  // Revenue
  ORDER_PURCHASE: 'order_purchase',
  ORDER_SUBSCRIPTION: 'order_subscription',
  WHOLESALE_SALE: 'wholesale_sale',
  PLATFORM_SUBSCRIPTION: 'platform_subscription',
  CREATOR_SUBSCRIPTION: 'creator_subscription',
  ENROLLMENT_PURCHASE: 'enrollment_purchase',
  ENROLLMENT_SUBSCRIPTION: 'enrollment_subscription',

  // Inventory
  INVENTORY_PURCHASE: 'inventory_purchase',
  PURCHASE_RETURN: 'purchase_return',
  INVENTORY_LOSS: 'inventory_loss',
  INVENTORY_ADJUSTMENT: 'inventory_adjustment',
  COGS: 'cogs',

  // Operational expenses
  RENT: 'rent',
  UTILITIES: 'utilities',
  EQUIPMENT: 'equipment',
  SUPPLIES: 'supplies',
  MAINTENANCE: 'maintenance',
  MARKETING: 'marketing',
  OTHER_EXPENSE: 'other_expense',

  // Operational income
  CAPITAL_INJECTION: 'capital_injection',
  RETAINED_EARNINGS: 'retained_earnings',
  TIP_INCOME: 'tip_income',
  OTHER_INCOME: 'other_income',
} as const;

export type TransactionCategoryValue = (typeof TRANSACTION_CATEGORY)[keyof typeof TRANSACTION_CATEGORY];
export const TRANSACTION_CATEGORY_VALUES: string[] = Object.values(TRANSACTION_CATEGORY);
