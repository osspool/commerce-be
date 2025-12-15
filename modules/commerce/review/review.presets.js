/**
 * Review Module Middleware Presets
 */

import { presets as authPresets } from '#common/middleware/auth.middleware.js';

/** List reviews - public */
export const listReviews = (_instance) => [];

/** Get single review - public */
export const getReview = (_instance) => [];

/** Create review - authenticated users */
export const createReview = (instance) => authPresets.authenticated(instance);

/** Update review - authenticated users (ownership checked in controller) */
export const updateReview = (instance) => authPresets.authenticated(instance);

/** Delete review - admin only */
export const deleteReview = (instance) => authPresets.admin(instance);

export default {
  listReviews,
  getReview,
  createReview,
  updateReview,
  deleteReview,
};
