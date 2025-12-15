import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Stock Entry Model
 *
 * Tracks inventory per product-variant-branch combination.
 * Single source of truth for stock levels when INVENTORY_USE_STOCK_ENTRY=true.
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

  // Scannable barcode (can differ from SKU)
  barcode: {
    type: String,
    trim: true,
    sparse: true,
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

  // Metadata
  lastCountDate: Date,
  notes: String,

}, { timestamps: true });

// Compound unique index: one entry per product-variant-branch
stockEntrySchema.index(
  { product: 1, variantSku: 1, branch: 1 },
  { unique: true }
);

// Fast barcode lookup by branch
stockEntrySchema.index({ barcode: 1, branch: 1 }, { sparse: true });

// Low stock alerts query
stockEntrySchema.index({ quantity: 1, reorderPoint: 1 });

// Virtuals
stockEntrySchema.virtual('availableQuantity').get(function() {
  return Math.max(0, this.quantity - this.reservedQuantity);
});

stockEntrySchema.virtual('needsReorder').get(function() {
  return this.reorderPoint > 0 && this.quantity <= this.reorderPoint;
});

stockEntrySchema.set('toJSON', { virtuals: true });
stockEntrySchema.set('toObject', { virtuals: true });

const StockEntry = mongoose.models.StockEntry || mongoose.model('StockEntry', stockEntrySchema);
export default StockEntry;
