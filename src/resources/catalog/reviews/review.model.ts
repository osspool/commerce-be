import type { AnyRecord } from '@classytic/arc';
import { arcLog } from '@classytic/arc/logger';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

const log = arcLog('review-model');

// ============================================
// SUB-DOCUMENT INTERFACES
// ============================================

export interface IReviewReply {
  content?: string;
  repliedBy?: Types.ObjectId;
  repliedAt?: Date;
}

// ============================================
// MAIN REVIEW INTERFACE
// ============================================

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface IReview extends AnyRecord {
  user: Types.ObjectId;
  product: Types.ObjectId;
  order?: Types.ObjectId;
  title?: string;
  rating: number;
  comment?: string;
  helpfulCount: number;
  isVerifiedPurchase: boolean;
  status: ReviewStatus;
  reply?: IReviewReply;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewDocument = HydratedDocument<IReview>;

interface IReviewModel extends mongoose.Model<IReview> {
  calculateAverageRating(productId: Types.ObjectId): Promise<void>;
}

const reviewSchema = new Schema<IReview, IReviewModel>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    order: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
    },
    title: {
      type: String,
      maxlength: 150,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      maxlength: 2000,
    },
    helpfulCount: {
      type: Number,
      default: 0,
    },
    isVerifiedPurchase: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: REVIEW_STATUSES,
      default: 'approved',
    },
    reply: {
      content: String,
      repliedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      repliedAt: Date,
    },
  },
  { timestamps: true },
);

// Indexes
reviewSchema.index({ product: 1, status: 1 });
reviewSchema.index({ user: 1, product: 1 }, { unique: true });
reviewSchema.index({ user: 1 });

// Calculate and update product rating
reviewSchema.statics.calculateAverageRating = async function (productId: Types.ObjectId): Promise<void> {
  const result = await this.aggregate([
    { $match: { product: productId, status: 'approved' } },
    {
      $group: {
        _id: '$product',
        averageRating: { $avg: '$rating' },
        numReviews: { $sum: 1 },
      },
    },
  ]);

  try {
    const engine = await ensureCatalogEngine();
    const ctx = { actorId: 'review-sync', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };
    const stats =
      result.length > 0
        ? { averageRating: Math.round(result[0].averageRating * 10) / 10, totalReviews: result[0].numReviews }
        : { averageRating: 0, totalReviews: 0 };

    await engine.repositories.product.updateReviewStats(String(productId), stats, ctx);
  } catch (error) {
    log.error('Error calculating average rating:', error);
  }
};

// Hooks
reviewSchema.post('save', function (this: ReviewDocument) {
  (this.constructor as IReviewModel).calculateAverageRating(this.product);
});

reviewSchema.post('findOneAndUpdate', async (doc: ReviewDocument | null) => {
  if (doc) {
    await (doc.constructor as unknown as IReviewModel).calculateAverageRating(doc.product);
  }
});

reviewSchema.post('findOneAndDelete', async (doc: ReviewDocument | null) => {
  if (doc) {
    await (doc.constructor as unknown as IReviewModel).calculateAverageRating(doc.product);
  }
});

const Review =
  (mongoose.models.Review as IReviewModel) || mongoose.model<IReview, IReviewModel>('Review', reviewSchema);
export default Review;
