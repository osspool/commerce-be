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

  // Branch role in inventory hierarchy
  // head_office: Can receive purchases, initiate transfers
  // sub_branch: Can only receive transfers, do local adjustments
  role: {
    type: String,
    enum: ['head_office', 'sub_branch'],
    default: 'sub_branch',
    index: true,
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

// Unique slug for stable URLs (admin UI, receipts, etc.)
branchSchema.index({ slug: 1 }, { unique: true });

// Ensure only one default branch (pre-save for .save() calls)
branchSchema.pre('save', async function() {
  if (this.isDefault && this.isModified('isDefault')) {
    await this.constructor.updateMany(
      { _id: { $ne: this._id }, isDefault: true },
      { isDefault: false }
    );
  }
});

// Ensure only one default branch (pre-findOneAndUpdate for update operations)
branchSchema.pre('findOneAndUpdate', async function() {
  const update = this.getUpdate();
  const isSettingDefault = update?.isDefault === true || update?.$set?.isDefault === true;

  if (isSettingDefault) {
    const docId = this.getQuery()._id;
    await this.model.updateMany(
      { _id: { $ne: docId }, isDefault: true },
      { isDefault: false }
    );
  }
});

// Ensure only one default branch (pre-updateOne for updateOne operations)
branchSchema.pre('updateOne', async function() {
  const update = this.getUpdate();
  const isSettingDefault = update?.isDefault === true || update?.$set?.isDefault === true;

  if (isSettingDefault) {
    const docId = this.getQuery()._id;
    await this.model.updateMany(
      { _id: { $ne: docId }, isDefault: true },
      { isDefault: false }
    );
  }
});

// Ensure only one head office (pre-save)
branchSchema.pre('save', async function() {
  if (this.role === 'head_office' && this.isModified('role')) {
    await this.constructor.updateMany(
      { _id: { $ne: this._id }, role: 'head_office' },
      { role: 'sub_branch' }
    );
  }
});

// Ensure only one head office (pre-findOneAndUpdate)
branchSchema.pre('findOneAndUpdate', async function() {
  const update = this.getUpdate();
  const isSettingHeadOffice = update?.role === 'head_office' || update?.$set?.role === 'head_office';

  if (isSettingHeadOffice) {
    const docId = this.getQuery()._id;
    await this.model.updateMany(
      { _id: { $ne: docId }, role: 'head_office' },
      { role: 'sub_branch' }
    );
  }
});

// Ensure only one head office (pre-updateOne)
branchSchema.pre('updateOne', async function() {
  const update = this.getUpdate();
  const isSettingHeadOffice = update?.role === 'head_office' || update?.$set?.role === 'head_office';

  if (isSettingHeadOffice) {
    const docId = this.getQuery()._id;
    await this.model.updateMany(
      { _id: { $ne: docId }, role: 'head_office' },
      { role: 'sub_branch' }
    );
  }
});

// Auto-slug from name (updateOnChange: regenerate slug when name is updated)
branchSchema.plugin(slugPlugin, {
  sourceField: 'name',
  slugField: 'slug',
  updateOnChange: true,
});

const Branch = mongoose.models.Branch || mongoose.model('Branch', branchSchema);
export default Branch;
