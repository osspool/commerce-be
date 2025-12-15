import { presets as authPresets } from '#common/middleware/auth.middleware.js';

export const publicAccess = (instance) => authPresets.public(instance);

export const adminOnly = (instance) => authPresets.admin(instance);

export default {
  publicAccess,
  adminOnly,
};

