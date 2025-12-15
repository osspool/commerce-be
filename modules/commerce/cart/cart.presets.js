import { presets as authPresets } from '#common/middleware/auth.middleware.js';

export const authenticatedUser = (instance) => authPresets.authenticated(instance);

export default {
  authenticatedUser,
};

