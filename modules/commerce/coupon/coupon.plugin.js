import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import couponController from './coupon.controller.js';
import couponSchemas, { validateCouponSchema } from './coupon.schemas.js';
import couponPresets from './coupon.presets.js';

async function couponPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, couponController, {
      tag: 'Coupons',
      basePath: '/coupons',
      schemas: couponSchemas,
      auth: {
        list: ['admin'],
        get: ['admin'],
        create: ['admin'],
        update: ['admin'],
        remove: ['admin'],
      },
      middlewares: {
        list: couponPresets.authenticatedOrgScoped(instance),
        get: couponPresets.authenticatedOrgScoped(instance),
        create: couponPresets.createCoupon(instance),
        update: couponPresets.updateCoupon(instance),
        remove: couponPresets.deleteCoupon(instance),
      },
      additionalRoutes: [
        {
          method: 'POST',
          path: '/validate/:code',
          summary: 'Validate coupon',
          handler: couponController.validateCoupon,
          authRoles: ['user', 'admin'],
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
