/**
 * Arc Presets — Multi-Tenant Configuration
 *
 * Pre-configured presets for multi-tenant applications.
 * organizationId = branchId (Better Auth org).
 */

import { multiTenantPreset } from '@classytic/arc/presets';

/**
 * Organization-scoped preset (STRICT).
 * Always requires auth, always filters by organizationId.
 * Use for branch-scoped resources (inventory, budgets, etc.).
 */
export const orgScoped = multiTenantPreset({
  tenantField: 'organizationId',
});

/**
 * Company-wide preset (FLEXIBLE).
 * Requires auth but org filter is optional on all CRUD routes.
 * Use for company-wide resources (accounts, fiscal periods) where
 * org context provides auth scope but documents are NOT filtered by org.
 */
export const companyWide = multiTenantPreset({
  tenantField: 'organizationId',
  allowPublic: ['list', 'get', 'create', 'update', 'delete'],
});
