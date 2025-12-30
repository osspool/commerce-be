/**
 * Branch Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 69 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 81% less code!
 *
 * Everything is defined in branch.resource.js:
 * - Routes (CRUD + 3 custom operations)
 * - Schemas & validation
 * - Permissions
 * - Events (created, updated, deleted, default-changed)
 *
 * Branch is a foundational module used by Inventory and POS.
 */

import branchResource from './branch.resource.js';

// That's it! The resource definition handles everything
export default branchResource.toPlugin();
