import { Repository } from '@classytic/mongokit';
import Review from './review.model.js';

class ReviewRepository extends Repository {
  constructor() {
    super(Review, [], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  async getUserReview(userId, productId) {
    return this.getByQuery(
      { user: userId, product: productId },
      { lean: true }
    );
  }

  async checkVerifiedPurchase(userId, productId) {
    const Order = (await import('#modules/sales/orders/order.model.js')).default;
    const order = await Order.findOne({
      customer: userId,
      'items.product': productId,
      status: { $in: ['delivered', 'completed'] },
    }).lean();

    return {
      isVerified: !!order,
      orderId: order?._id || null,
    };
  }
}

export default new ReviewRepository();
