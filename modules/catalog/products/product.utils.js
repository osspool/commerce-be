/**
 * Product Utilities
 * Helper functions for product operations
 */

import config from '#config/index.js';

function normalizeRoles(userOrRoles) {
  if (!userOrRoles) return [];
  if (Array.isArray(userOrRoles)) return userOrRoles.filter(Boolean);
  if (typeof userOrRoles === 'string') return [userOrRoles];
  const roles = userOrRoles.roles;
  if (Array.isArray(roles)) return roles.filter(Boolean);
  if (typeof roles === 'string') return [roles];
  // Back-compat: some callers may pass { role: 'admin' }
  if (typeof userOrRoles.role === 'string') return [userOrRoles.role];
  return [];
}

export function canViewCostPrice(userOrRoles) {
  const roles = normalizeRoles(userOrRoles);
  const allowed = config?.costPrice?.viewRoles || [];
  return roles.some(r => allowed.includes(r));
}

export function canManageCostPrice(userOrRoles) {
  const roles = normalizeRoles(userOrRoles);
  const allowed = config?.costPrice?.manageRoles || [];
  return roles.some(r => allowed.includes(r));
}

/**
 * Filter cost price fields based on user role
 * Only admin and store-manager can view cost prices
 *
 * @param {Object|Array} data - Product or array of products
 * @param {Object|string|string[]} userOrRoles - request.user, role, or roles[]
 * @returns {Object|Array} Filtered data
 */
export function filterCostPriceByRole(data, userOrRoles) {
  if (!data) return data;

  if (canViewCostPrice(userOrRoles)) {
    return data; // Return as-is for authorized roles
  }

  // Remove cost price from response for unauthorized roles
  if (Array.isArray(data)) {
    return data.map(item => removeCostPriceFields(item));
  }

  return removeCostPriceFields(data);
}

/**
 * Remove cost price fields from a product object
 *
 * @param {Object} product - Product object
 * @returns {Object} Product without cost price fields
 */
function removeCostPriceFields(product) {
  if (!product) return product;

  const filtered = { ...product };
  delete filtered.costPrice;
  delete filtered.profitMargin;
  delete filtered.profitMarginPercent;

  // Remove cost price from NEW variants structure
  if (filtered.variants) {
    filtered.variants = filtered.variants.map(variant => {
      const { costPrice, ...rest } = variant;
      return rest;
    });
  }

  // POS responses may include branchStock.variants[].costPrice
  if (filtered.branchStock?.variants?.length) {
    filtered.branchStock = { ...filtered.branchStock };
    filtered.branchStock.variants = filtered.branchStock.variants.map(v => {
      if (!v || typeof v !== 'object') return v;
      const { costPrice, ...rest } = v;
      return rest;
    });
  }

  // Lookup responses may include a matchedVariant snapshot
  if (filtered.matchedVariant && typeof filtered.matchedVariant === 'object') {
    const { costPrice, ...rest } = filtered.matchedVariant;
    filtered.matchedVariant = rest;
  }

  return filtered;
}
