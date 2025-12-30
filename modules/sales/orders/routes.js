/**
 * Order Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 151 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 91% less code!
 *
 * Everything is defined in order.resource.js:
 * - Routes (CRUD + 11 custom operations)
 * - Schemas & validation
 * - Permissions (customer vs admin)
 * - Events (checkout, fulfillment, cancellation, refunds)
 * - Dependencies (revenue system integration)
 *
 * Complex workflows (checkout, fulfill, cancel, refund) handled by dedicated handlers
 * while maintaining clean ResourceDefinition pattern.
 */

import orderResource from './order.resource.js';

// That's it! The resource definition handles everything
export default orderResource.toPlugin();
