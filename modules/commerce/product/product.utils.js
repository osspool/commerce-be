/**
 * Product Utilities
 * Helper functions for product operations
 */

/**
 * Filter cost price fields based on user role
 * Only admin and store-manager can view cost prices
 *
 * @param {Object|Array} data - Product or array of products
 * @param {string} userRole - User's role
 * @returns {Object|Array} Filtered data
 */
export function filterCostPriceByRole(data, userRole) {
  if (!data) return data;

  // Roles allowed to view cost prices
  const allowedRoles = ['admin', 'store-manager'];
  if (allowedRoles.includes(userRole)) {
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

  // Remove cost price from variants
  if (filtered.variations) {
    filtered.variations = filtered.variations.map(variation => ({
      ...variation,
      options: variation.options?.map(option => {
        const { costPrice, ...rest } = option;
        return rest;
      }),
    }));
  }

  return filtered;
}
