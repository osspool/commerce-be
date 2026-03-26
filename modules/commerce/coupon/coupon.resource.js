/**
 * Coupon Resource Definition
 *
 * Discount coupon management for promotional campaigns.
 * Standard CRUD + custom validation endpoint.
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
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

  adapter: createAdapter(Coupon, couponRepository),
  controller: couponController,
  queryParser,

  permissions: getResourcePermissions('coupon'),
  schemaOptions: couponSchemas,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/validate/:code',
      summary: 'Validate coupon',
      handler: 'validateCoupon',
      permissions: permissions.coupons.validateCoupon,
      wrapHandler: false,
      schema: validateCouponSchema,
    },
  ],

  events: events,
});

export default couponResource;
