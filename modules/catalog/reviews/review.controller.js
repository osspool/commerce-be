import { BaseController } from '@classytic/arc';
import reviewRepository from './review.repository.js';
import { reviewSchemaOptions } from './review.schemas.js';
import { BadRequestError } from '#shared/utils/errors.js';

/**
 * Review Controller
 * Standard CRUD + custom create with verified purchase check
 */
class ReviewController extends BaseController {
  constructor() {
    super(reviewRepository, { schemaOptions: reviewSchemaOptions });
    this.getMyReview = this.getMyReview.bind(this);
  }

  /**
   * Override create to add verified purchase check
   * POST /reviews
   */
  async create(context) {
    const { product, title, rating, comment } = context.body;
    const userId = context.user?._id || context.user?.id;

    // Check for existing review
    const existingReview = await reviewRepository.getUserReview(userId, product);
    if (existingReview) {
      throw new BadRequestError('You have already reviewed this product');
    }

    // Check for verified purchase
    const { isVerified, orderId } = await reviewRepository.checkVerifiedPurchase(userId, product);

    const review = await reviewRepository.create({
      user: userId,
      product,
      title,
      rating,
      comment,
      isVerifiedPurchase: isVerified,
      order: orderId,
    });

    return {
      success: true,
      data: review,
      status: 201,
      meta: { message: 'Review created successfully' },
    };
  }

  /**
   * Get current user's review for a product
   * GET /reviews/my/:productId
   */
  async getMyReview(req, reply) {
    const { productId } = req.params;
    const userId = req.user._id || req.user.id;

    const review = await reviewRepository.getUserReview(userId, productId);
    return reply.send({ success: true, data: review });
  }
}

export default new ReviewController();
