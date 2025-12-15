/**
 * Transaction Module Middleware Presets (Authentication/Authorization)
 * 
 * Simple single-tenant clinic system - admin authentication only
 * 
 * Validation Layers:
 * 1. Schema (schemas.js): fieldRules + strictAdditionalProperties rejects invalid fields
 * 2. Repository (transaction.repository.js): Business logic with mongokit's validationChainPlugin
 * 
 * @module modules/transaction/transaction.presets
 */

import { presets as authPresets, withAuth } from '#common/middleware/auth.middleware.js';

export const authenticatedOrgScoped = (instance) =>
  authPresets.admin(instance);

export const createTransaction = (instance) =>
  authPresets.admin(instance);

export const updateTransaction = (instance) =>
  authPresets.admin(instance);

export const deleteTransaction = (instance) =>
  withAuth(['admin', 'superadmin'])(instance);

/**
 * Financial reports
 * Admin only
 */
export const viewReports = (instance) =>
  authPresets.admin(instance);

/**
 * All transaction presets
 */
export default {
  authenticatedOrgScoped,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  viewReports,
};
