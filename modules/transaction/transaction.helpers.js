/**
 * Transaction Helpers
 * Validation and utility functions for transactions
 */

/**
 * Validate transaction update
 * For ecommerce: Only allow notes updates on library-managed transactions
 */
export function validateTransactionUpdate(transaction, updateBody) {
  // All ecommerce transactions are library-managed
  // Only allow notes updates
  const allowedFields = ['notes'];
  
  const attemptedFields = Object.keys(updateBody);
  const violations = [];

  attemptedFields.forEach(field => {
    if (!allowedFields.includes(field)) {
      violations.push({ field, reason: 'Field not allowed - only notes can be updated' });
    }
  });

  if (violations.length > 0) {
    return {
      valid: false,
      message: 'Only notes field can be updated on transactions',
      violations,
    };
  }

  return { valid: true };
}

export default {
  validateTransactionUpdate,
};
