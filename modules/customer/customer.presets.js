/**
 * Customer Module Middleware Presets
 *
 * Module-specific authentication and authorization patterns
 * for customer routes.
 *
 * Pattern Philosophy:
 * - Customers are user-linked (not org-scoped at model level)
 * - Organization filtering happens through memberships (indirect)
 * - No direct create route (auto-created from memberships)
 * - All operations require authentication
 *
 * @module modules/customer/customer.presets
 */

import { presets as authPresets } from '#common/middleware/auth.middleware.js';

/**
 * List/view customers
 * Authenticated users can list customers
 * Filtering by org happens at controller level (via memberships)
 */
export const viewCustomers = (instance) =>
  authPresets.authenticated(instance);

/**
 * Update customer
 * Authenticated users can update customer info
 */
export const updateCustomer = (instance) =>
  authPresets.authenticated(instance);

/**
 * Delete customer
 * Controlled by permissions (platform staff only)
 */
export const deleteCustomer = (instance) =>
  authPresets.authenticated(instance);

/**
 * All customer presets
 */
export default {
  viewCustomers,
  updateCustomer,
  deleteCustomer,
};
