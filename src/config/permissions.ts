/**
 * Permissions (Source of Truth)
 *
 * Keep `#config/permissions.js` as the stable import path across the codebase.
 * Internals live in `config/permissions/*` for cleaner organization.
 */

export type { AllPermissions } from './permissions/index.js';
export { default } from './permissions/index.js';
