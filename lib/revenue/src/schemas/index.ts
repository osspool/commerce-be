/**
 * Schema Index
 * @classytic/revenue
 *
 * Core schemas for injection into your models
 *
 * Note: Enums are separate. Import them from '@classytic/revenue/enums'
 */

// Re-export core schemas only
export * from './transaction/index.js';
export * from './subscription/index.js';
export * from './escrow/index.js';
export * from './split/index.js';

// Default export with core schemas
import transactionSchemas from './transaction/index.js';
import subscriptionSchemas from './subscription/index.js';
import escrowSchemas from './escrow/index.js';
import splitSchemas from './split/index.js';

export default {
  ...transactionSchemas,
  ...subscriptionSchemas,
  ...escrowSchemas,
  ...splitSchemas,
};

