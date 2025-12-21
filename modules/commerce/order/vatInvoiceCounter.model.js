import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * VAT Invoice Counter (per branch per BD day)
 *
 * Keeps invoice sequences monotonic per store per day:
 * - Keyed by (branch, dateKey) where dateKey = YYYYMMDD in Asia/Dhaka
 * - seq increments atomically via findOneAndUpdate + $inc
 */
const vatInvoiceCounterSchema = new Schema({
  branch: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  dateKey: { type: String, required: true, index: true }, // YYYYMMDD (Asia/Dhaka)
  seq: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

vatInvoiceCounterSchema.index({ branch: 1, dateKey: 1 }, { unique: true });

vatInvoiceCounterSchema.statics.nextSeq = async function(branchId, dateKey, session = null) {
  const doc = await this.findOneAndUpdate(
    { branch: branchId, dateKey },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...(session ? { session } : {}) }
  );

  return doc.seq;
};

const VatInvoiceCounter =
  mongoose.models.VatInvoiceCounter || mongoose.model('VatInvoiceCounter', vatInvoiceCounterSchema);

export default VatInvoiceCounter;

