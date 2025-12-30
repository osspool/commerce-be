/**
 * Job Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 24 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 46% less code!
 *
 * Everything is defined in job.resource.js:
 * - Routes (CRUD operations for monitoring)
 * - Schemas & validation
 * - Permissions (admin-only viewing)
 * - Events (created, started, completed, failed, retrying)
 *
 * Job queue management for background processing.
 * Jobs are typically created by system processes, not via API.
 */

import jobResource from './job.resource.js';

// That's it! The resource definition handles everything
export default jobResource.toPlugin();