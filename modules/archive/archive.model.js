import mongoose from 'mongoose';

const { Schema } = mongoose;

const archiveSchema = new Schema({
  type: { type: String, enum: ['order', 'transaction'], required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  rangeFrom: { type: Date },
  rangeTo: { type: Date },
  filePath: { type: String, required: true },
  format: { type: String, enum: ['json'], default: 'json' },
  recordCount: { type: Number, default: 0 },
  sizeBytes: { type: Number, default: 0 },
  archivedAt: { type: Date, default: () => new Date() },
  expiresAt: { type: Date },
  notes: { type: String },
}, { timestamps: true });

// Indexes optimized for mongokit pagination
// Compound index for multi-tenant archive pagination
archiveSchema.index({ organizationId: 1, archivedAt: -1, _id: -1 });

// Compound index for filtering by type with pagination
archiveSchema.index({ organizationId: 1, type: 1, archivedAt: -1, _id: -1 });

// Single-field indexes for specific lookups
archiveSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Archive = mongoose.models.Archive || mongoose.model('Archive', archiveSchema);
export default Archive;
