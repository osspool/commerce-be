import { Repository } from '@classytic/mongokit';
import Coupon from './coupon.model.js';

class CouponRepository extends Repository {
  constructor() {
    super(Coupon, [], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  async getByCode(code) {
    return this.Model.findOne({ code: code.toUpperCase() }).lean();
  }

  async validateCoupon(code, orderAmount) {
    const coupon = await this.Model.findOne({ code: code.toUpperCase() });
    if (!coupon) {
      throw new Error('Coupon not found');
    }

    if (!coupon.isValid()) {
      throw new Error('Coupon is not valid or has expired');
    }

    if (!coupon.canBeUsed(orderAmount)) {
      throw new Error(`Minimum order amount of ${coupon.minOrderAmount} required`);
    }

    return coupon;
  }

  async incrementUsage(couponId) {
    return this.Model.findByIdAndUpdate(
      couponId,
      { $inc: { usedCount: 1 } },
      { new: true }
    );
  }
}

export default new CouponRepository();
