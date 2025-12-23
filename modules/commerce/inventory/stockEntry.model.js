import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Stock Entry Model
 *
 * Tracks inventory per product-variant-branch combination.
 * Single source of truth for stock levels.
 *
 * For simple products (no variants): variantSku is null
 * For products with variants: one entry per variant per branch
 *
 * Key: (product, variantSku, branch) - unique combination
 */
const stockEntrySchema = new Schema({
  product: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },

  // Variant identifier (null for simple products without variants)
  variantSku: {
    type: String,
    trim: true,
    default: null,
  },

  // Branch reference (ObjectId when Branch model exists, string for now)
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },

  // Available quantity
  quantity: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },

  // Reserved (in cart/pending orders) - for future stock reservation
  reservedQuantity: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Cost price for this stock batch (for profit calculations)
  costPrice: {
    type: Number,
    min: 0,
  },

  // Reorder alerts
  reorderPoint: { type: Number, default: 0 },
  reorderQuantity: { type: Number, default: 0 },
  needsReorder: { type: Boolean, default: false, index: true },

  // Active status (synced from product variant isActive)
  // When variant is disabled, stock entry is marked inactive
  isActive: { type: Boolean, default: true },

  // Product snapshot - stored when product is hard-deleted
  // Allows historical reporting even after product deletion
  productSnapshot: {
    name: String,
    sku: String,
    basePrice: Number,
    costPrice: Number,
    category: String,
    variantAttributes: Schema.Types.Mixed, // e.g., { size: "M", color: "Red" }
    deletedAt: Date,
  },

  // Metadata
  lastCountDate: Date,
  notes: String,

}, { timestamps: true });

// Compound unique index: one entry per product-variant-branch
stockEntrySchema.index(
  { product: 1, variantSku: 1, branch: 1 },
  { unique: true }
);

// Hot-path indexes:
// - POS scans can hit (branch, variantSku) when scanning variant SKU directly.
// - Branch stock lookups frequently query by (branch, product, variantSku).
stockEntrySchema.index({ branch: 1, variantSku: 1 });
stockEntrySchema.index({ branch: 1, product: 1, variantSku: 1 });

// Low stock alerts query
stockEntrySchema.index({ branch: 1, needsReorder: 1 });

// Virtuals
stockEntrySchema.virtual('availableQuantity').get(function() {
  return Math.max(0, this.quantity - this.reservedQuantity);
});

stockEntrySchema.set('toJSON', { virtuals: true });
stockEntrySchema.set('toObject', { virtuals: true });

// Product type invariant validation
// Ensures simple products only have variantSku=null entries
// Ensures variant products only have variantSku!=null entries
stockEntrySchema.pre('save', async function() {
  // Only validate if this is a new entry or variantSku changed
  if (!this.isNew && !this.isModified('variantSku')) {
    return;
  }

  const Product = mongoose.model('Product');
  const product = await Product.findById(this.product).lean();

  if (!product) {
    return; // Product doesn't exist yet (might be in creation)
  }

  // Skip validation if product doesn't have productType (legacy data)
  if (!product.productType) {
    return;
  }

  // Validate invariant
  if (product.productType === 'simple' && this.variantSku) {
    throw new Error('Simple products cannot have variant stock entries');
  }

  if (product.productType === 'variant' && !this.variantSku) {
    throw new Error('Variant products must specify variantSku in stock entries');
  }
});

const StockEntry = mongoose.models.StockEntry || mongoose.model('StockEntry', stockEntrySchema);
export default StockEntry;
