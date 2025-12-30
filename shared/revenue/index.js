/**
 * Revenue Utilities
 * 
 * Simplified exports for ecommerce use case (order purchases only).
 * Re-exports library enums/schemas and provides app-specific utilities.
 */

// Enums - re-exports from @classytic/revenue + app-specific payment methods
export * from './enums.js';

// Schemas - re-exports from @classytic/revenue + app-specific API schemas
export * from './schemas.js';

// Payment verification - updates Order after manual payment verification
export * from './payment-verification.utils.js';

// Refund utilities - for order refunds
export * from './refund.utils.js';

// Default export
import enums from './enums.js';
import schemas from './schemas.js';

export default {
  ...enums,
  ...schemas,
};
