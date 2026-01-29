import { BaseController } from '@classytic/arc';
import couponRepository from './coupon.repository.js';
import { couponSchemaOptions } from './coupon.schemas.js';

class CouponController extends BaseController {
  constructor() {
    super(couponRepository, { schemaOptions: couponSchemaOptions });
    this.validateCoupon = this.validateCoupon.bind(this);
  }

  async validateCoupon(req, reply) {
    const { code } = req.params;
    const { orderAmount } = req.body;

    // validateCoupon throws BadRequestError if invalid (caught by global handler)
    const coupon = await couponRepository.validateCoupon(code, orderAmount);
    const discount = coupon.calculateDiscount(orderAmount);

    return reply.send({
      success: true,
      data: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountAmount: coupon.discountAmount,
        discount,
        finalAmount: orderAmount - discount,
      },
    });
  }
}

export default new CouponController();
