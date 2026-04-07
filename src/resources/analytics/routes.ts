/**
 * Analytics Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: createRoutes with itemWrapper/messageWrapper
 * AFTER: Arc resource with additionalRoutes
 *
 * All configuration moved to analytics.resource.js:
 * - Custom analytics endpoint
 * - Permissions
 * - Schema validation
 */

import analyticsResource from './analytics.resource.js';

export default analyticsResource.toPlugin();
