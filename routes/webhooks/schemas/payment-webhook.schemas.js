/**
 * Payment Webhook Schemas
 * Request validation schemas only
 */

// Manual verification request
export const manualVerificationBody = {
  type: 'object',
  required: ['transactionId'],
  properties: {
    transactionId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      description: 'Transaction ID to verify',
    },
    notes: {
      type: 'string',
      maxLength: 500,
      description: 'Optional verification notes',
    },
  },
};

// Manual rejection request
export const manualRejectionBody = {
  type: 'object',
  required: ['transactionId', 'reason'],
  properties: {
    transactionId: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      description: 'Transaction ID to reject',
    },
    reason: {
      type: 'string',
      minLength: 3,
      maxLength: 500,
      description: 'Reason for rejection (e.g., invalid TrxID, fraud)',
    },
  },
};

// Provider webhook params
export const providerParams = {
  type: 'object',
  required: ['provider'],
  properties: {
    provider: {
      type: 'string',
      description: 'Payment provider name (stripe, sslcommerz, bkash, nagad)',
      examples: ['stripe', 'sslcommerz', 'bkash', 'nagad'],
    },
  },
};

export default {
  manualVerificationBody,
  manualRejectionBody,
  providerParams,
};
