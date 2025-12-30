import BaseController from '#core/base/BaseController.js';
import reviewRepository from './review.repository.js';
import { reviewSchemaOptions } from './review.schemas.js';

/**
 * Review Controller
 * Standard CRUD + custom create with verified purchase check
 */
class ReviewController extends BaseController {
  constructor() {
    super(reviewRepository, reviewSchemaOptions);
    this.getMyReview = this.getMyReview.bind(this);
  }

  /**
   * Override create to add verified purchase check
   * POST /reviews
   */
  async create(req, reply) {
    const { product, title, rating, comment } = req.body;
    const userId = req.user._id;

    try {
      // Check for existing review
      const existingReview = await reviewRepository.getUserReview(userId, product);
      if (existingReview) {
        return reply.code(400).send({
          success: false,
          message: 'You have already reviewed this product',
        });
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

      return reply.code(201).send({ success: true, data: review });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  /**
   * Get current user's review for a product
   * GET /reviews/my/:productId
   */
  async getMyReview(req, reply) {
    const { productId } = req.params;
    const userId = req.user._id;

    try {
      const review = await reviewRepository.getUserReview(userId, productId);
      return reply.code(200).send({ success: true, data: review });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }
}

export default new ReviewController(reviewRepository, reviewSchemaOptions);
