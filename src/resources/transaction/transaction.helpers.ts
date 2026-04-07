/**
 * Transaction Helpers
 * Validation and utility functions for transactions
 */

interface ValidationViolation {
  field: string;
  reason: string;
}

interface ValidationResult {
  valid: boolean;
  message?: string;
  violations?: ValidationViolation[];
}

/**
 * Validate transaction update
 * Allow limited corrections (e.g., flow/type/tax) while keeping core audit fields protected.
 */
export function validateTransactionUpdate(
  _transaction: Record<string, unknown>,
  updateBody: Record<string, unknown>,
): ValidationResult {
  const allowedFields = [
    'notes',
    'description',
    'metadata',
    'flow',
    'type',
    'amount',
    'fee',
    'tax',
    'net',
    'taxDetails',
    'method',
    'paymentDetails',
    'branch',
    'branchCode',
    'source',
  ];

  const attemptedFields = Object.keys(updateBody);
  const violations: ValidationViolation[] = [];

  attemptedFields.forEach((field) => {
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
