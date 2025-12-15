import mongoose from 'mongoose';
import slugPlugin from '@classytic/mongoose-slug-plugin';

const { Schema } = mongoose;

const imageSchema = new Schema({
  url: { type: String, required: true, trim: true },
  variants: {
    thumbnail: { type: String, trim: true },
    medium: { type: String, trim: true },
  },
  order: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  alt: { type: String, trim: true },
}, { _id: false });

const dimensionsCmSchema = new Schema({
  length: { type: Number, min: 0 },
  width: { type: Number, min: 0 },
  height: { type: Number, min: 0 },
}, { _id: false });

const shippingSchema = new Schema({
  weightGrams: { type: Number, min: 0 },
  dimensionsCm: dimensionsCmSchema,
}, { _id: false });

const variationOptionSchema = new Schema({
  value: { type: String, required: true },
  sku: { type: String, trim: true },           // SKU for this variant (e.g., "TSHIRT-RED-M")
  barcode: { type: String, trim: true },       // Scannable barcode
  priceModifier: { type: Number, default: 0 },
  costPrice: { type: Number, min: 0, default: 0 },
  images: [imageSchema],
  quantity: { type: Number, default: 0 },      // Legacy: used when multi-location is off
  shipping: shippingSchema,                    // Optional variant-level shipping override
}, { _id: false });

const variationSchema = new Schema({
  name: { type: String, required: true },
  options: [variationOptionSchema],
}, { _id: false });

const discountSchema = new Schema({
  type: { type: String, enum: ['percentage', 'fixed'], required: true },
  value: { type: Number, required: true, min: 0 },
  startDate: Date,
  endDate: Date,
  description: String,
}, { _id: false });

const statsSchema = new Schema({
  totalSales: { type: Number, default: 0 },
  totalQuantitySold: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
}, { _id: false });

/**
 * Product Schema
 * 
 * Category: simple string, frontend-defined
 * Slug: auto-generated from name, globally unique
 */
const productSchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, unique: true },
  shortDescription: { type: String, trim: true },
  description: String,
  basePrice: { type: Number, required: true, min: 0 },
  costPrice: { type: Number, min: 0, default: 0 },
  quantity: { type: Number, required: true, min: 0 },

  // SKU & Barcode (for simple products without variants)
  sku: { type: String, trim: true },
  barcode: { type: String, trim: true },

  images: [imageSchema],
  
  // Category - simple string, FE-defined
  category: { type: String, required: true, trim: true, lowercase: true },
  parentCategory: { type: String, trim: true, lowercase: true, default: null },

  // Style tags (enum set) for quick filtering like ?style=street
  style: [{
    type: String,
    enum: ['casual', 'street', 'urban', 'desi', 'formal', 'sport', 'ethnic', 'party'],
  }],
  
  variations: [variationSchema],

  // Shipping attributes used for delivery charge estimation (e.g., RedX charge calculator)
  // Values are optional; when missing, checkout/shipping logic will treat metrics as unknown.
  shipping: shippingSchema,

  properties: Schema.Types.Mixed,
  tags: [String],
  
  stats: { type: statsSchema, default: () => ({}) },
  
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  numReviews: { type: Number, default: 0, min: 0 },
  
  discount: discountSchema,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Minimal indexes - only what's essential
// Note: slug already has unique:true in field definition (line 47)
productSchema.index({ category: 1 });
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ createdAt: -1, _id: -1 }); // Pagination

// SKU & Barcode indexes for fast lookup (POS scanning)
productSchema.index({ sku: 1 }, { sparse: true });
productSchema.index({ barcode: 1 }, { sparse: true });
productSchema.index({ 'variations.options.sku': 1 }, { sparse: true });
productSchema.index({ 'variations.options.barcode': 1 }, { sparse: true });

// Auto-slug from name
productSchema.plugin(slugPlugin, { sourceField: 'name', slugField: 'slug' });

// Virtuals
productSchema.virtual('isDiscountActive').get(function() {
  if (!this.discount?.startDate || !this.discount?.endDate) return false;
  const now = new Date();
  return this.discount.startDate <= now && this.discount.endDate >= now;
});

productSchema.virtual('currentPrice').get(function() {
  if (this.isDiscountActive) {
    const { type, value } = this.discount;
    if (type === 'percentage') return this.basePrice * (1 - value / 100);
    if (type === 'fixed') return Math.max(this.basePrice - value, 0);
  }
  return this.basePrice;
});

productSchema.virtual('featuredImage').get(function() {
  if (!this.images?.length) return null;
  return this.images.find(img => img.isFeatured) || this.images[0];
});

productSchema.virtual('totalSales').get(function() {
  return this.stats?.totalSales || 0;
});

productSchema.virtual('profitMargin').get(function() {
  if (!this.costPrice) return null;
  const sellPrice = this.currentPrice; // Uses discount if active
  return sellPrice - this.costPrice;
});

productSchema.virtual('profitMarginPercent').get(function() {
  if (!this.costPrice || this.currentPrice === 0) return null;
  const margin = this.currentPrice - this.costPrice;
  return (margin / this.currentPrice) * 100;
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
export default Product;
