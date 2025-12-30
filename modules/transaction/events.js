/**
 * Transaction Domain Events
 *
 * Events emitted by the payment/revenue system for transaction lifecycle.
 * Transactions are created by @classytic/revenue library, not manually.
 */

export const events = {
  'transaction:created': {
    module: 'transaction',
    description: 'Emitted when a new payment transaction is created by revenue system',
    schema: {
      type: 'object',
      required: ['transactionId', 'type', 'amount', 'status'],
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
        type: { type: 'string', enum: ['income', 'expense', 'transfer'], description: 'Transaction type' },
        amount: { type: 'number', description: 'Transaction amount' },
        status: { type: 'string', enum: ['pending', 'completed', 'failed', 'refunded'], description: 'Transaction status' },
        referenceId: { type: 'string', description: 'Reference ID (e.g., order ID)' },
        referenceModel: { type: 'string', description: 'Reference model (e.g., Order)' },
        gateway: { type: 'string', description: 'Payment gateway (manual, bkash, etc.)' },
      },
    },
  },

  'transaction:verified': {
    module: 'transaction',
    description: 'Emitted when a pending payment is verified by admin/webhook',
    schema: {
      type: 'object',
      required: ['transactionId', 'referenceId'],
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
        referenceId: { type: 'string', description: 'Related order/reference ID' },
        amount: { type: 'number', description: 'Verified amount' },
        gateway: { type: 'string', description: 'Payment gateway' },
        verifiedBy: { type: 'string', description: 'Admin user ID who verified' },
      },
    },
  },

  'transaction:failed': {
    module: 'transaction',
    description: 'Emitted when a transaction fails or is rejected',
    schema: {
      type: 'object',
      required: ['transactionId', 'reason'],
      properties: {
        transactionId: { type: 'string', description: 'Transaction ID' },
        referenceId: { type: 'string', description: 'Related order/reference ID' },
        reason: { type: 'string', description: 'Failure reason' },
        gateway: { type: 'string', description: 'Payment gateway' },
      },
    },
  },

  'transaction:refunded': {
    module: 'transaction',
    description: 'Emitted when a transaction is refunded',
    schema: {
      type: 'object',
      required: ['transactionId', 'refundAmount'],
      properties: {
        transactionId: { type: 'string', description: 'Original transaction ID' },
        refundAmount: { type: 'number', description: 'Refund amount' },
        referenceId: { type: 'string', description: 'Related order ID' },
        reason: { type: 'string', description: 'Refund reason' },
      },
    },
  },
};

export const handlers = {
  // Transaction module doesn't subscribe to events yet
  // Transactions are created by revenue library hooks
};
