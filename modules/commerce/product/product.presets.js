import { presets as authPresets } from '#common/middleware/auth.middleware.js';

export const authenticatedOrgScoped = (instance) => authPresets.public(instance);

export const createProduct = (instance) => authPresets.admin(instance);

export const updateProduct = (instance) => authPresets.admin(instance);

export const deleteProduct = (instance) => authPresets.admin(instance);

export default {
  authenticatedOrgScoped,
  createProduct,
  updateProduct,
  deleteProduct,
};

