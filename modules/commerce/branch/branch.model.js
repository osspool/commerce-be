import mongoose from 'mongoose';
import slugPlugin from '@classytic/mongoose-slug-plugin';

const { Schema } = mongoose;

/**
 * Branch Model
 *
 * Represents a physical store/warehouse location.
 * Used for multi-location inventory tracking and POS operations.
 *
 * Every deployment must have at least one branch.
 * Default branch is created on first run if none exists.
 */
const branchSchema = new Schema({
  // URL-friendly slug (auto-generated from name)
  slug: {
    type: String,
    unique: true,
  },

  // Unique code for the branch (e.g., "DHK-1", "CTG-MAIN")
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },

  // Display name
  name: {
    type: String,
    required: true,
    trim: true,
  },

  // Branch type
  type: {
    type: String,
    enum: ['store', 'warehouse', 'outlet', 'franchise'],
    default: 'store',
  },

  // Address
  address: {
    line1: { type: String, trim: true },
    line2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'Bangladesh' },
  },

  // Contact
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },

  // Operating hours (simple format)
  operatingHours: {
    type: String,
    trim: true,
    default: '10:00 AM - 10:00 PM',
  },

  // Settings
  isDefault: {
    type: Boolean,
    default: false,
    index: true,
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },

  // Manager reference
  manager: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  // Metadata
  notes: String,

}, { timestamps: true });

// Ensure only one default branch
branchSchema.pre('save', async function() {
  if (this.isDefault && this.isModified('isDefault')) {
    await this.constructor.updateMany(
      { _id: { $ne: this._id }, isDefault: true },
      { isDefault: false }
    );
  }
});

// Auto-slug from name
branchSchema.plugin(slugPlugin, { sourceField: 'name', slugField: 'slug' });

const Branch = mongoose.models.Branch || mongoose.model('Branch', branchSchema);
export default Branch;
