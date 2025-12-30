/**
 * Coupon Resource Definition
 *
 * Discount coupon management for promotional campaigns.
 * Standard CRUD + custom validation endpoint.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Coupon from './coupon.model.js';
import couponRepository from './coupon.repository.js';
import couponController from './coupon.controller.js';
import permissions from '#config/permissions.js';
import couponSchemas, { validateCouponSchema } from './coupon.schemas.js';
import { events } from './events.js';

const couponResource = defineResource({
  name: 'coupon',
  displayName: 'Coupons',
  tag: 'Coupons',
  prefix: '/coupons',

  model: Coupon,
  repository: couponRepository,
  controller: couponController,

  permissions: permissions.coupons,
  schemaOptions: couponSchemas,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/validate/:code',
      summary: 'Validate coupon',
      handler: 'validateCoupon',
      authRoles: permissions.coupons.validate,
      schemas: validateCouponSchema,
    },
  ],

  events: events,
});

export default couponResource;
