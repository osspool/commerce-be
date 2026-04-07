import mongoose, { Schema, type HydratedDocument } from 'mongoose';

export interface ICMSMetadata {
  title?: string;
  description?: string;
  keywords?: string[];
  ogImage?: string;
}

export interface ICMS {
  name: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  content: unknown;
  metadata?: ICMSMetadata;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CMSDocument = HydratedDocument<ICMS>;

const cmsSchema = new Schema<ICMS>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    content: {
      type: Schema.Types.Mixed,
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
  },
);

// Unique slug for fast lookups
cmsSchema.index({ slug: 1 }, { unique: true });
cmsSchema.index({ status: 1 });

const CMS = mongoose.models.CMS || mongoose.model('CMS', cmsSchema);

export default CMS;
