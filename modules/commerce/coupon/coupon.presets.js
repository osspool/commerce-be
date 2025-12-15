import { presets as authPresets } from '#common/middleware/auth.middleware.js';

export const authenticatedOrgScoped = (instance) => authPresets.admin(instance);

export const createCoupon = (instance) => authPresets.admin(instance);

export const updateCoupon = (instance) => authPresets.admin(instance);

export const deleteCoupon = (instance) => authPresets.admin(instance);

export const validateCoupon = (instance) => authPresets.authenticated(instance);

export default {
  authenticatedOrgScoped,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
};

