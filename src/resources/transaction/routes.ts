/**
 * Transaction Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * Everything is defined in transaction.resource.js:
 * - Routes (CRUD + statement export + 3 financial reports)
 * - Schemas & validation
 * - Permissions (admin-only)
 * - Events (created, verified, failed, refunded)
 */

import transactionResource from './transaction.resource.js';

// That's it! The resource definition handles everything
export default transactionResource.toPlugin();
