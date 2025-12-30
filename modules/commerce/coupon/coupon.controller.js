import BaseController from '#core/base/BaseController.js';
import couponRepository from './coupon.repository.js';
import { couponSchemaOptions } from './coupon.schemas.js';

class CouponController extends BaseController {
  constructor() {
    super(couponRepository, couponSchemaOptions);
    this.validateCoupon = this.validateCoupon.bind(this);
  }

  async validateCoupon(req, reply) {
    const { code } = req.params;
    const { orderAmount } = req.body;

    try {
      const coupon = await couponRepository.validateCoupon(code, orderAmount);
      const discount = coupon.calculateDiscount(orderAmount);

      return reply.code(200).send({
        success: true,
        data: {
          code: coupon.code,
          discountType: coupon.discountType,
          discountAmount: coupon.discountAmount,
          discount,
          finalAmount: orderAmount - discount,
        },
      });
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error.message,
      });
    }
  }
}

export default new CouponController();
