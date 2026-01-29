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
// (Use Arc directly: import { resourceRegistry } from '@classytic/arc')
export { resourceRegistry } from '@classytic/arc';
export { hookSystem } from '@classytic/arc';

// Policy Engine (application-specific RBAC + ownership + tenant)
// TODO: Redesign as pluggable interface in Arc
export { definePolicy, policyRegistry, combinePolicies } from './policies/PolicyEngine.js';

// Testing utilities - Re-export from Arc
export { createTestHarness, generateTestFile } from '@classytic/arc/testing';
