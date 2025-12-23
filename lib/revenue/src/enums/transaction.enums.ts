/**
 * Transaction Enums
 * @classytic/revenue
 *
 * Library-managed transaction enums only.
 * Users should define their own categories and merge with these.
 */

// ============ TRANSACTION TYPE ============
/**
 * Transaction Type - Income vs Expense
 *
 * INCOME: Money coming in (payments, subscriptions, purchases)
 * EXPENSE: Money going out (refunds, payouts)
 *
 * Users can map these in their config via transactionTypeMapping
 */
export const TRANSACTION_TYPE = {
  INCOME: 'income',
  EXPENSE: 'expense',
} as const;

export type TransactionType = typeof TRANSACTION_TYPE;
export type TransactionTypeValue = TransactionType[keyof TransactionType];
export const TRANSACTION_TYPE_VALUES = Object.values(
  TRANSACTION_TYPE,
) as TransactionTypeValue[];

// ============ TRANSACTION STATUS ============
/**
 * Transaction Status - Library-managed states
 */
export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  PAYMENT_INITIATED: 'payment_initiated',
  PROCESSING: 'processing',
  REQUIRES_ACTION: 'requires_action',
  VERIFIED: 'verified',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
} as const;

export type TransactionStatus = typeof TRANSACTION_STATUS;
export type TransactionStatusValue = TransactionStatus[keyof TransactionStatus];
export const TRANSACTION_STATUS_VALUES = Object.values(
  TRANSACTION_STATUS,
) as TransactionStatusValue[];

// ============ LIBRARY CATEGORIES ============
/**
 * Categories managed by this library
 *
 * SUBSCRIPTION: Recurring subscription payments
 * PURCHASE: One-time purchases
 *
 * Users should spread these into their own category enums:
 *
 * @example
 * import { LIBRARY_CATEGORIES } from '@classytic/revenue';
 *
 * export const MY_CATEGORIES = {
 *   ...LIBRARY_CATEGORIES,
 *   SALARY: 'salary',
 *   RENT: 'rent',
 *   EQUIPMENT: 'equipment',
 * } as const;
 */
export const LIBRARY_CATEGORIES = {
  SUBSCRIPTION: 'subscription',
  PURCHASE: 'purchase',
} as const;

export type LibraryCategories = typeof LIBRARY_CATEGORIES;
export type LibraryCategoryValue = LibraryCategories[keyof LibraryCategories];
export const LIBRARY_CATEGORY_VALUES = Object.values(
  LIBRARY_CATEGORIES,
) as LibraryCategoryValue[];

const transactionTypeSet = new Set<TransactionTypeValue>(TRANSACTION_TYPE_VALUES);
const transactionStatusSet = new Set<TransactionStatusValue>(
  TRANSACTION_STATUS_VALUES,
);
const libraryCategorySet = new Set<LibraryCategoryValue>(LIBRARY_CATEGORY_VALUES);

export function isLibraryCategory(value: unknown): value is LibraryCategoryValue {
  return typeof value === 'string' && libraryCategorySet.has(value as LibraryCategoryValue);
}

export function isTransactionType(value: unknown): value is TransactionTypeValue {
  return typeof value === 'string' && transactionTypeSet.has(value as TransactionTypeValue);
}

export function isTransactionStatus(
  value: unknown,
): value is TransactionStatusValue {
  return typeof value === 'string' && transactionStatusSet.has(value as TransactionStatusValue);
}
