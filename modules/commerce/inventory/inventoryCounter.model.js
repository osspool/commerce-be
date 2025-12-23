import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Inventory Counter
 *
 * Atomic sequence generator per type + period (yyyymm).
 * Used for supplier codes, purchase invoices, transfers, and stock requests.
 */
const inventoryCounterSchema = new Schema({
  type: { type: String, required: true, index: true },
  yyyymm: { type: String, required: true, index: true },
  seq: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

inventoryCounterSchema.index({ type: 1, yyyymm: 1 }, { unique: true });

inventoryCounterSchema.statics.nextSeq = async function(type, yyyymm, session = null) {
  const doc = await this.findOneAndUpdate(
    { type, yyyymm },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, ...(session ? { session } : {}) }
  );

  return doc.seq;
};

const InventoryCounter =
  mongoose.models.InventoryCounter || mongoose.model('InventoryCounter', inventoryCounterSchema);

export default InventoryCounter;
