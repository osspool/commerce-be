import mongoose, { Schema, type HydratedDocument, type Types, type ClientSession } from 'mongoose';

export interface IVatInvoiceCounter {
  branch: Types.ObjectId;
  dateKey: string;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IVatInvoiceCounterModel extends mongoose.Model<IVatInvoiceCounter> {
  nextSeq(branchId: Types.ObjectId | string, dateKey: string, session?: ClientSession | null): Promise<number>;
}

export type VatInvoiceCounterDocument = HydratedDocument<IVatInvoiceCounter>;

/**
 * VAT Invoice Counter (per branch per BD day)
 *
 * Keeps invoice sequences monotonic per store per day:
 * - Keyed by (branch, dateKey) where dateKey = YYYYMMDD in Asia/Dhaka
 * - seq increments atomically via findOneAndUpdate + $inc
 */
const vatInvoiceCounterSchema = new Schema<IVatInvoiceCounter>(
  {
    branch: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    dateKey: { type: String, required: true, index: true }, // YYYYMMDD (Asia/Dhaka)
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

vatInvoiceCounterSchema.index({ branch: 1, dateKey: 1 }, { unique: true });

vatInvoiceCounterSchema.statics.nextSeq = async function (
  branchId: Types.ObjectId | string,
  dateKey: string,
  session: ClientSession | null = null,
): Promise<number> {
  const doc = await this.findOneAndUpdate(
    { branch: branchId, dateKey },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true, ...(session ? { session } : {}) },
  );

  return doc.seq;
};

const VatInvoiceCounter =
  (mongoose.models.VatInvoiceCounter as IVatInvoiceCounterModel) ||
  mongoose.model<IVatInvoiceCounter, IVatInvoiceCounterModel>('VatInvoiceCounter', vatInvoiceCounterSchema);

export default VatInvoiceCounter;
