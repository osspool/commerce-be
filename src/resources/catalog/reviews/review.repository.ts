import { Repository } from '@classytic/mongokit';
import Review from './review.model.js';
import type { IReview } from './review.model.js';

interface VerifiedPurchaseResult {
  isVerified: boolean;
  orderId: string | null;
}

class ReviewRepository extends Repository<IReview> {
  constructor() {
    super(Review, [], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  async getUserReview(userId: string, productId: string): Promise<IReview | null> {
    return this.getByQuery({ user: userId, product: productId }, { lean: true });
  }

  async checkVerifiedPurchase(userId: string, productId: string): Promise<VerifiedPurchaseResult> {
    const Order = (await import('#resources/sales/orders/order.model.js')).default;
    const order = (await Order.findOne({
      customer: userId,
      'items.product': productId,
      status: { $in: ['delivered', 'completed'] },
    }).lean()) as { _id: string } | null;

    return {
      isVerified: !!order,
      orderId: order?._id || null,
    };
  }
}

export default new ReviewRepository();
