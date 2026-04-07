/**
 * Order Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * Everything is defined in order.resource.js:
 * - Routes (CRUD + 11 custom operations)
 * - Schemas & validation
 * - Permissions (customer vs admin)
 * - Events (checkout, fulfillment, cancellation, refunds)
 * - Dependencies (revenue system integration)
 */

import orderResource from './order.resource.js';

export default orderResource.toPlugin();
