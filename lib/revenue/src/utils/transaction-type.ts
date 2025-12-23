/**
 * Transaction Type Detection & Classification
 *
 * Distinguishes between:
 * - Monetization-managed transactions (library-controlled, strict rules)
 * - Manual admin transactions (flexible, admin-controlled)
 *
 * @module @classytic/revenue/utils/transaction-type
 */

import type {
  TransactionDocument,
  TransactionTypeOptions,
  FieldUpdateValidationResult,
} from '../types/index.js';

/**
 * Transaction types with different protection rules
 */
export const TRANSACTION_MANAGEMENT_TYPE = {
  MONETIZATION: 'monetization', // Library-managed (subscriptions, purchases)
  MANUAL: 'manual',             // Admin-managed (expenses, income, adjustments)
} as const;

export type TransactionManagementType = typeof TRANSACTION_MANAGEMENT_TYPE[keyof typeof TRANSACTION_MANAGEMENT_TYPE];

/**
 * Default monetization categories
 * Users can extend this via config.categoryMappings
 */
const DEFAULT_MONETIZATION_CATEGORIES = [
  'subscription',
  'purchase',
];

/**
 * Check if category is monetization-related
 * @param category - Transaction category
 * @param additionalCategories - Additional categories from user config
 */
function isMonetizationCategory(
  category: string,
  additionalCategories: string[] = []
): boolean {
  const allCategories = [...DEFAULT_MONETIZATION_CATEGORIES, ...additionalCategories];
  return allCategories.includes(category);
}

/**
 * Check if transaction is monetization-managed
 *
 * Monetization-managed means:
 * - Created through subscription/purchase flows via the library
 * - Status controlled by payment webhooks/verification
 * - Amount/commission calculated by library
 * - Protected fields: status, amount, commission, gateway, verifiedAt, verifiedBy
 *
 * @param transaction - Transaction document or data
 * @param options - Options
 */
export function isMonetizationTransaction(
  transaction: Partial<TransactionDocument>,
  options: TransactionTypeOptions = {}
): boolean {
  const {
    targetModels = ['Subscription', 'Membership'],
    additionalCategories = [],
  } = options;

  // Check 1: Has referenceModel from registered models
  if (transaction.referenceModel && targetModels.includes(transaction.referenceModel)) {
    return true;
  }

  // Check 2: Category is monetization-related
  if (transaction.category) {
    return isMonetizationCategory(transaction.category, additionalCategories);
  }

  return false;
}

/**
 * Check if transaction is manual admin transaction
 *
 * Manual transactions:
 * - Created directly by admins for operational expenses/income
 * - Can be self-verified by admins
 * - More flexible updates allowed
 * - No commission/gateway complexity
 *
 * @param transaction - Transaction document or data
 * @param options - Options (same as isMonetizationTransaction)
 */
export function isManualTransaction(
  transaction: Partial<TransactionDocument>,
  options: TransactionTypeOptions = {}
): boolean {
  return !isMonetizationTransaction(transaction, options);
}

/**
 * Get transaction type
 *
 * @param transaction - Transaction document or data
 * @param options - Options (same as isMonetizationTransaction)
 */
export function getTransactionType(
  transaction: Partial<TransactionDocument>,
  options: TransactionTypeOptions = {}
): TransactionManagementType {
  return isMonetizationTransaction(transaction, options)
    ? TRANSACTION_MANAGEMENT_TYPE.MONETIZATION
    : TRANSACTION_MANAGEMENT_TYPE.MANUAL;
}

/**
 * Protected fields for monetization transactions
 * These fields cannot be updated directly by admins
 */
export const PROTECTED_MONETIZATION_FIELDS = [
  'status',
  'amount',
  'platformCommission',
  'netAmount',
  'verifiedAt',
  'verifiedBy',
  'gateway',
  'webhook',
  'metadata.commission',
  'metadata.gateway',
  'type',
  'category',
  'referenceModel',
  'referenceId',
] as const;

/**
 * Editable fields for monetization transactions (before verification)
 * These fields can be updated by frontend/customer before payment is verified
 */
export const EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION = [
  'reference',
  'paymentDetails',
  'notes',
] as const;

/**
 * Allowed fields for manual transaction creation
 */
export const MANUAL_TRANSACTION_CREATE_FIELDS = [
  'organizationId',
  'type',
  'category',
  'amount',
  'method',
  'reference',
  'paymentDetails',
  'notes',
  'date', // Transaction date (can be backdated)
  'description',
] as const;

/**
 * Allowed fields for manual transaction updates
 */
export const MANUAL_TRANSACTION_UPDATE_FIELDS = [
  'amount',
  'method',
  'reference',
  'paymentDetails',
  'notes',
  'date',
  'description',
] as const;

/**
 * Get allowed update fields based on transaction type and status
 *
 * @param transaction - Transaction document
 * @param options - Options for transaction type detection
 */
export function getAllowedUpdateFields(
  transaction: Partial<TransactionDocument>,
  options: TransactionTypeOptions = {}
): readonly string[] {
  const type = getTransactionType(transaction, options);

  if (type === TRANSACTION_MANAGEMENT_TYPE.MONETIZATION) {
    // Monetization transactions: only allow pre-verification edits
    if (transaction.status === 'pending') {
      return EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION;
    }
    // After verification, no direct updates allowed
    return [];
  }

  // Manual transactions: more flexible
  if (transaction.status === 'verified' || transaction.status === 'completed') {
    // Once verified/completed, only notes can be updated
    return ['notes'];
  }

  // Pending manual transactions can be fully edited
  return MANUAL_TRANSACTION_UPDATE_FIELDS;
}

/**
 * Validate if field update is allowed
 *
 * @param transaction - Transaction document
 * @param fieldName - Field being updated
 * @param options - Options for transaction type detection
 */
export function validateFieldUpdate(
  transaction: Partial<TransactionDocument>,
  fieldName: string,
  options: TransactionTypeOptions = {}
): FieldUpdateValidationResult {
  const allowedFields = getAllowedUpdateFields(transaction, options);

  if (allowedFields.includes(fieldName)) {
    return { allowed: true };
  }

  const type = getTransactionType(transaction, options);

  if (type === TRANSACTION_MANAGEMENT_TYPE.MONETIZATION) {
    if ((PROTECTED_MONETIZATION_FIELDS as readonly string[]).includes(fieldName)) {
      return {
        allowed: false,
        reason: `Field "${fieldName}" is protected for monetization transactions. Updates must go through payment flow.`,
      };
    }
  }

  return {
    allowed: false,
    reason: `Field "${fieldName}" cannot be updated for ${transaction.status} transactions.`,
  };
}

/**
 * Check if transaction can be self-verified by admin
 *
 * @param transaction - Transaction document
 * @param options - Options for transaction type detection
 */
export function canSelfVerify(
  transaction: Partial<TransactionDocument>,
  options: TransactionTypeOptions = {}
): boolean {
  const type = getTransactionType(transaction, options);

  // Only manual transactions can be self-verified
  if (type === TRANSACTION_MANAGEMENT_TYPE.MANUAL) {
    return transaction.status === 'pending';
  }

  return false;
}

export default {
  TRANSACTION_MANAGEMENT_TYPE,
  isMonetizationTransaction,
  isManualTransaction,
  getTransactionType,
  PROTECTED_MONETIZATION_FIELDS,
  EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION,
  MANUAL_TRANSACTION_CREATE_FIELDS,
  MANUAL_TRANSACTION_UPDATE_FIELDS,
  getAllowedUpdateFields,
  validateFieldUpdate,
  canSelfVerify,
};

