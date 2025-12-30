/**
 * Coupon Plugin - MIGRATED TO RESOURCE PATTERN
 *
 * BEFORE: 34 lines of boilerplate
 * AFTER: 13 lines of clean code
 *
 * REDUCTION: 62% less code!
 *
 * Everything is defined in coupon.resource.js:
 * - Routes (CRUD + validate endpoint)
 * - Schemas & validation
 * - Permissions
 * - Events (created, updated, deleted, used, expired)
 *
 * Discount coupons for promotional campaigns.
 */

import couponResource from './coupon.resource.js';

// That's it! The resource definition handles everything
export default couponResource.toPlugin();
