/**
 * Cost Price Filter Middleware
 * 
 * Filters cost price from responses based on user role.
 * Reusable across product, inventory, and related modules.
 */

/**
 * Check if user can view cost prices
 */
function canManageCostPrice(user) {
  if (!user) return false;
  const roles = user.roles || [];
  return roles.includes('admin') || roles.includes('superadmin') || roles.includes('finance-manager');
}

/**
 * Recursively filter cost price from object/array
 */
function filterCostPriceByRole(data, user) {
  if (!data) return data;

  const canSeeCost = canManageCostPrice(user);

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => filterCostPriceByRole(item, user));
  }

  // Handle objects (including Mongoose documents)
  if (typeof data === 'object') {
    // Convert Mongoose document to plain object
    const plainData = data.toObject ? data.toObject() : data;

    // If user can see cost, return as-is (but converted to plain object)
    if (canSeeCost) return plainData;

    // Filter cost price fields
    const filtered = { ...plainData };
    delete filtered.costPrice;

    // Filter variants if present
    if (Array.isArray(filtered.variants)) {
      filtered.variants = filtered.variants.map(v => {
        const plainVariant = v.toObject ? v.toObject() : v;
        const variant = { ...plainVariant };
        delete variant.costPrice;
        return variant;
      });
    }

    return filtered;
  }

  return data;
}

/**
 * Middleware: Filter cost price from response body
 */
export function costPriceFilterMiddleware(request, reply, done) {
  const originalSend = reply.send.bind(reply);
  
  reply.send = function(payload) {
    if (payload && typeof payload === 'object') {
      // Filter single data object
      if (payload.data) {
        payload.data = filterCostPriceByRole(payload.data, request.user);
      }
      // Filter docs array (paginated responses)
      if (payload.docs && Array.isArray(payload.docs)) {
        payload.docs = filterCostPriceByRole(payload.docs, request.user);
      }
    }
    return originalSend(payload);
  };

  done();
}

/**
 * Middleware: Strip cost price from request body on create/update
 */
export function stripCostPriceMiddleware(request, reply, done) {
  if (!canManageCostPrice(request.user)) {
    if (request.body) {
      delete request.body.costPrice;
      
      // Strip from variants
      if (Array.isArray(request.body.variants)) {
        request.body.variants = request.body.variants.map(v => {
          const variant = { ...v };
          delete variant.costPrice;
          return variant;
        });
      }
    }
  }
  done();
}

export { canManageCostPrice, filterCostPriceByRole };
