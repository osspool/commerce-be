import { Repository } from '@classytic/mongokit';
import type { IReview } from './review.model.js';
import Review from './review.model.js';

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

  /**
   * Verified-purchase check against `@classytic/order`. A review counts
   * as verified when the user has at least one `completed` or
   * `fulfilled` order containing the product (either as `lineId.offerId`
   * or as `lineId.snapshot.productId` metadata).
   *
   * This query bypasses the multi-tenant plugin on purpose because the
   * reviewer may be shopping across branches — a review is tied to the
   * product, not the branch. The engine's `Order` mongoose model is
   * used directly for the raw find, scoped only by customer + status.
   */
  async checkVerifiedPurchase(userId: string, productId: string): Promise<VerifiedPurchaseResult> {
    const { ensureOrderEngine } = await import('#resources/sales/orders/order.engine.js');
    const engine = await ensureOrderEngine();
    const order = (await engine.models.Order.findOne({
      customerId: userId,
      $or: [{ 'lines.metadata.productId': productId }, { 'lines.offerId': productId }],
      status: { $in: ['completed', 'fulfilled'] },
    }).lean()) as { _id: { toString(): string } } | null;

    return {
      isVerified: !!order,
      orderId: order ? order._id.toString() : null,
    };
  }
}

export default new ReviewRepository();
