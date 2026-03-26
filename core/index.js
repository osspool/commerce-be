/**
 * Core Framework Exports
 *
 * Application-specific core utilities and patterns.
 * For CRUD resources, use @classytic/arc framework.
 */

// Plugins
export * from './plugins/index.js';

// Factories (action-based routes, etc.)
export * from './factories/index.js';

// Event system (domain events)
export * from './events/index.js';

// Middleware
export * from './middleware/index.js';

// Utilities
export * from './utils/index.js';

// Documentation helpers
export * from './docs/index.js';

// Re-export Arc framework utilities for convenience
export { ResourceRegistry } from '@classytic/arc/registry';
export { createHookSystem } from '@classytic/arc/hooks';

// Policy Engine (application-specific RBAC + ownership + tenant)
// TODO: Redesign as pluggable interface in Arc
export { definePolicy, policyRegistry, combinePolicies } from './policies/PolicyEngine.js';
