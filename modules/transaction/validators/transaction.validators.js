/**
 * Transaction Validators
 * 
 * For ecommerce: ALL transactions are created by @classytic/revenue
 * Manual transaction creation is blocked
 */

import createError from 'http-errors';
import { blockIf } from '@classytic/mongokit';
import { validateTransactionUpdate } from '../transaction.helpers.js';

/**
 * Allow manual transaction creation only for admin/superadmin.
 * Internal/system creates (no request) are allowed.
 */
export const restrictManualCreateToAdmins = () =>
  blockIf(
    'restrict-manual-create',
    ['create'],
    (context) => {
      const roles = context?.request?.user?.roles;
      if (!roles) return false; // internal/system create
      const isAdmin = roles.includes('admin') || roles.includes('superadmin');
      return !isAdmin;
    },
    'Only admin/superadmin can create transactions manually'
  );

/**
 * Validate transaction update (allow minimal updates only)
 */
export const validateTransactionUpdateData = () => ({
  name: 'validate-transaction-update',
  operations: ['update'],

  async validate(context, repo) {
    if (!context.data) return;

    const transaction = await repo.getById(context.id, {
      lean: true,
      select: 'status',
      session: context.session
    });

    if (!transaction) {
      throw createError(404, 'Transaction not found');
    }

    const validation = validateTransactionUpdate(transaction, context.data);

    if (!validation.valid) {
      const error = createError(400, validation.message || 'Update not allowed');
      error.violations = validation.violations;
      throw error;
    }
  }
});

/**
 * Block transaction deletion
 * Transactions are immutable for accounting purposes
 */
export const blockTransactionDelete = () =>
  blockIf(
    'block-transaction-delete',
    ['delete'],
    (context) => {
      const roles = context?.request?.user?.roles;
      console.log('roles', roles);
      // If we cannot read roles (e.g., internal delete or missing request), defer to route auth and allow
      if (!roles) return false;
      const isAdmin = roles.includes('admin') || roles.includes('superadmin');
      // Block if not admin/superadmin
      return !isAdmin;
    },
    'Transactions cannot be deleted (immutable for accounting)'
  );
