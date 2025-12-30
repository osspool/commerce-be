/**
 * Product Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 122 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 89% less code!
 *
 * All configuration moved to product.resource.js:
 * - CRUD routes + 5 additional routes
 * - Schema generation with field rules
 * - Cost price middleware
 * - Permissions
 * - Events
 */

import productResource from './product.resource.js';

export default productResource.toPlugin();
