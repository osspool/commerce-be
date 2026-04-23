/**
 * Musok Invoice Model — Mushak 6.3 VAT Invoice Records
 *
 * Stores generated Mushak 6.3 invoices with sequential serial tracking.
 * Each record links back to the source (order, invoice JE, or manual).
 * Serial number is auto-incremented per branchCode+year combination.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const musokLineSchema = new Schema(
  {
    sequence: { type: Number, required: true },
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    totalValue: { type: Number, required: true },
    sdAmount: { type: Number, default: 0 },
    vatRate: { type: Number, required: true },
    vatAmount: { type: Number, required: true },
    /** Country-neutral tax class applied to this line (post fiscal-position remap). */
    vatRateCode: { type: String, trim: true },
    /** Exemption category if this line is EXEMPT (audit trail). */
    exemptionCategoryCode: { type: String, trim: true },
  },
  { _id: false },
);

const musokInvoiceSchema = new Schema(
  {
    /** Sequential Mushak serial: branchCode/YYYY/serial */
    mushakSerial: { type: String, required: true, unique: true, index: true },
    /** Calendar year for serial reset */
    serialYear: { type: Number, required: true, index: true },
    /** Sequential number within branchCode+year */
    serialNumber: { type: Number, required: true },

    /** Branch that issued this invoice */
    branchCode: { type: String, required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'organization', index: true },

    /** Source linkage */
    sourceModel: { type: String, enum: ['Order', 'JournalEntry', 'Manual'], default: 'Order' },
    sourceId: { type: Schema.Types.ObjectId, index: true },

    /** Seller info (from PlatformConfig.vat) */
    seller: {
      bin: { type: String, required: true },
      name: { type: String, required: true },
      address: { type: String, required: true },
      activityType: String,
    },

    /** Buyer info */
    buyer: {
      bin: String,
      nid: String,
      name: { type: String, required: true },
      address: String,
    },

    /** Invoice date */
    date: { type: Date, required: true, default: Date.now },

    /** Line items */
    lines: {
      type: [musokLineSchema],
      required: true,
      validate: [(v: unknown[]) => v.length > 0, 'At least one line required'],
    },

    /** Totals (all in paisa) */
    totalValue: { type: Number, required: true },
    totalSd: { type: Number, default: 0 },
    totalVat: { type: Number, required: true },
    grandTotal: { type: Number, required: true },

    currency: { type: String, default: 'BDT' },

    /**
     * NBR audit trail — the fiscal position that was applied when this
     * invoice was issued, plus the SRO / certificate reference authorizing
     * any exemption or zero-rating, and a plain-text reason for the audit log.
     * Populated by the resolver; null on straight domestic (NATIONAL) sales.
     */
    fiscalPosition: {
      type: String,
      enum: ['NATIONAL', 'INTERNATIONAL', 'DIPLOMATIC', 'EXEMPT_NGO', 'SEZ_BHTC_UTILITY', 'RMG_UTILITY'],
      default: null,
    },
    sroReference: { type: String, trim: true, default: null },
    exemptionReason: { type: String, trim: true, default: null },

    /** Status tracking */
    status: {
      type: String,
      enum: ['draft', 'issued', 'cancelled', 'voided'],
      default: 'issued',
    },
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true },
);

musokInvoiceSchema.index({ branchCode: 1, serialYear: 1 });
musokInvoiceSchema.index({ sourceModel: 1, sourceId: 1 });

/**
 * Atomic next serial — uses findOneAndUpdate with $inc to prevent
 * race conditions in concurrent invoice generation.
 */
musokInvoiceSchema.statics.getNextSerial = async (branchCode: string, year: number): Promise<number> => {
  const counter = await mongoose.connection
    .db!.collection('musok_counters')
    .findOneAndUpdate({ branchCode, year }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return counter!.seq as number;
};

const MusokInvoice = mongoose.models.MusokInvoice || mongoose.model('MusokInvoice', musokInvoiceSchema);

export default MusokInvoice;
