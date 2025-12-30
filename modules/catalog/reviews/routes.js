/**
 * Review Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 34 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 62% less code!
 *
 * Everything is defined in review.resource.js:
 * - Routes (CRUD + custom "my review" endpoint)
 * - Schemas & validation
 * - Permissions
 * - Events (review lifecycle, moderation)
 */

import reviewResource from './review.resource.js';

// That's it! The resource definition handles everything
export default reviewResource.toPlugin();
