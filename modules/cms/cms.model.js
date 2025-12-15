import mongoose from 'mongoose';

const cmsSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    content: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    metadata: {
      title: String,
      description: String,
      keywords: [String],
      ogImage: String,
    },
    publishedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    collection: 'cms',
  }
);

// Index for fast slug lookups
cmsSchema.index({ slug: 1 });
cmsSchema.index({ status: 1 });

const CMS = mongoose.model('CMS', cmsSchema);

export default CMS;
