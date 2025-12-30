/**
 * Transaction Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 121 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 89% less code!
 *
 * Everything is defined in transaction.resource.js:
 * - Routes (CRUD + statement export + 3 financial reports)
 * - Schemas & validation
 * - Permissions (admin-only)
 * - Events (created, verified, failed, refunded)
 *
 * Payment & Revenue System:
 * - Transactions created automatically via @classytic/revenue
 * - Order purchases → revenue.monetization.create()
 * - Refunds → revenue.payments.refund()
 * - Payment verification → revenue.payments.verify()
 *
 * Financial Reports:
 * - P&L statement, Category breakdown, Cash flow trend
 */

import transactionResource from './transaction.resource.js';

// That's it! The resource definition handles everything
export default transactionResource.toPlugin();
