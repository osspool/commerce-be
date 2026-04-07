/**
 * Size Guide Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 55 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 76% less code!
 *
 * Everything is defined in size-guide.resource.js:
 * - Routes (CRUD + slug lookup)
 * - Schemas & validation
 * - Permissions
 * - Events (created, updated, deleted)
 *
 * Simple CRUD API for managing size guide templates.
 */

import sizeGuideResource from './size-guide.resource.js';

// That's it! The resource definition handles everything
export default sizeGuideResource.toPlugin();
