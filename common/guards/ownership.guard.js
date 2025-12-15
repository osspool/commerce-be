import createError from 'http-errors';

export function ownershipGuard(options = {}) {
  const { Model, idParam = 'id', orgField = 'organizationId' } = options;

  if (!Model) {
    throw new Error('ownershipGuard requires a Mongoose model');
  }

  return async function (request, reply) {
    const roles = Array.isArray(request.user?.roles) ? request.user.roles : [];

    if (roles.includes('superadmin')) {
      return;
    }

    const resourceId = request.params?.[idParam];
    if (!resourceId) {
      throw createError(400, 'Missing resource id');
    }

    const orgId = request.organizationId || request.context?.organizationId;
    if (!orgId) {
      throw createError(403, 'Organization context required');
    }

    const exists = await Model.exists({ _id: resourceId, [orgField]: orgId });
    if (!exists) {
      throw createError(404, 'Resource not found or access denied');
    }
  };
}

export default ownershipGuard;
