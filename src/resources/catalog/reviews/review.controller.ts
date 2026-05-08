import {
  type AnyRecord,
  BaseController,
  type IControllerResponse,
  type IRequestContext,
  type RequestWithExtras,
} from '@classytic/arc';
import { getUserId } from '@classytic/arc/scope';
import type { FastifyReply } from 'fastify';
import { BadRequestError } from '#shared/utils/errors.js';
import type { IReview } from './review.model.js';
import reviewRepository from './review.repository.js';
import { reviewSchemaOptions } from './review.schemas.js';

interface GetMyReviewRequest extends RequestWithExtras {
  params: { productId: string };
}

/**
 * Review Controller
 * Standard CRUD + custom create with verified purchase check.
 */
class ReviewController extends BaseController<IReview & AnyRecord> {
  constructor() {
    super(reviewRepository, {
      schemaOptions: reviewSchemaOptions,
    });
    this.getMyReview = this.getMyReview.bind(this);
  }

  /**
   * Override create to add verified purchase check
   * POST /reviews
   */
  async create(context: IRequestContext): Promise<IControllerResponse<IReview>> {
    const body = context.body as { product: string; title?: string; rating: number; comment?: string };
    const { product, title, rating, comment } = body;
    const userId = context.scope?.userId;

    // Check for existing review
    const existingReview = await reviewRepository.getUserReview(userId as string, product);
    if (existingReview) {
      throw new BadRequestError('You have already reviewed this product');
    }

    // Check for verified purchase
    const { isVerified, orderId } = await reviewRepository.checkVerifiedPurchase(userId as string, product);

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
      data: review as IReview,
      status: 201,
      meta: { message: 'Review created successfully' } as Record<string, unknown>,
    };
  }

  /**
   * Get current user's review for a product
   * GET /reviews/my/:productId
   */
  async getMyReview(req: GetMyReviewRequest, reply: FastifyReply): Promise<void> {
    const { productId } = req.params as { productId: string };
    const userId = getUserId(req.scope);

    const review = await reviewRepository.getUserReview(userId as string, productId);
    return reply.send({ data: review });
  }
}

export default new ReviewController();
