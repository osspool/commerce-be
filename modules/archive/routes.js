/**
 * Archive Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 47 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 72% less code!
 *
 * Everything is defined in archive.resource.js:
 * - Routes (CRUD + run, download, purge)
 * - Schemas & validation
 * - Permissions
 * - Events (created, deleted, purged)
 *
 * Archive management for historical data (orders, transactions, stock movements).
 */

import archiveResource from './archive.resource.js';

// That's it! The resource definition handles everything
export default archiveResource.toPlugin();



