import mongoose from 'mongoose';
import Product from '#modules/catalog/products/product.model.js';

const { Schema } = mongoose;

const reviewSchema = new Schema({
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
    enum: ['pending', 'approved', 'rejected'],
    default: 'approved',
  },
  reply: {
    content: String,
    repliedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    repliedAt: Date,
  },
}, { timestamps: true });

// Indexes
reviewSchema.index({ product: 1, status: 1 });
reviewSchema.index({ user: 1, product: 1 }, { unique: true });
reviewSchema.index({ user: 1 });

// Calculate and update product rating
reviewSchema.statics.calculateAverageRating = async function(productId) {
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
    if (result.length > 0) {
      await Product.findByIdAndUpdate(productId, {
        averageRating: Math.round(result[0].averageRating * 10) / 10,
        numReviews: result[0].numReviews,
      });
    } else {
      await Product.findByIdAndUpdate(productId, {
        averageRating: 0,
        numReviews: 0,
      });
    }
  } catch (error) {
    console.error('Error calculating average rating:', error);
  }
};

// Hooks
reviewSchema.post('save', function() {
  this.constructor.calculateAverageRating(this.product);
});

reviewSchema.post('findOneAndUpdate', async function(doc) {
  if (doc) {
    await doc.constructor.calculateAverageRating(doc.product);
  }
});

reviewSchema.post('findOneAndDelete', async function(doc) {
  if (doc) {
    await doc.constructor.calculateAverageRating(doc.product);
  }
});

const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);
export default Review;
