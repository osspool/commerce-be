import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import couponController from './coupon.controller.js';
import couponSchemas, { validateCouponSchema } from './coupon.schemas.js';
import permissions from '#config/permissions.js';

async function couponPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, couponController, {
      tag: 'Coupons',
      basePath: '/coupons',
      schemas: couponSchemas,
      auth: permissions.coupons,
      additionalRoutes: [
        {
          method: 'POST',
          path: '/validate/:code',
          summary: 'Validate coupon',
          handler: couponController.validateCoupon,
          authRoles: permissions.coupons.validate,
          schemas: validateCouponSchema,
        },
      ],
    });

    done();
  }, { prefix: '/coupons' });
}

export default fp(couponPlugin, {
  name: 'coupon',
  dependencies: ['register-core-plugins'],
});
