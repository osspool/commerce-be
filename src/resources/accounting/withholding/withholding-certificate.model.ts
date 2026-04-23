/**
 * Withholding Certificate Model — VDS (Mushak 6.6) and TDS certificate tracking.
 *
 * When a buyer withholds VDS/TDS from a supplier payment, they issue a certificate.
 * This model tracks certificates both ISSUED (we withheld, owe NBR) and RECEIVED
 * (withheld from us, claimable as credit on Mushak 9.1 line 15 or income tax return).
 *
 * Reconciles against:
 * - VDS payable (2136) / VDS receivable (1153) in journal entries
 * - TDS payable (2135) / TDS receivable (1152) in journal entries
 * - Mushak 9.1 line 15 VDS credit totals
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const withholdingCertificateSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'organization', required: true, index: true },

    /** VDS (Mushak 6.6) or TDS (income tax withholding) */
    type: { type: String, enum: ['VDS', 'TDS'], required: true },

    /** ISSUED = we withheld from supplier; RECEIVED = buyer withheld from us */
    direction: { type: String, enum: ['ISSUED', 'RECEIVED'], required: true },

    /** Certificate number (Mushak 6.6 serial for VDS, or form 16A-equivalent for TDS) */
    certificateNumber: { type: String, required: true, trim: true },

    /** Date on the certificate */
    certificateDate: { type: Date, required: true },

    /** Fiscal period this certificate belongs to (YYYY-MM) */
    period: { type: String, required: true, trim: true, index: true },

    /** Counterparty BIN (for VDS) or TIN (for TDS) */
    counterpartyTin: { type: String, required: true, trim: true },

    /** Counterparty name */
    counterpartyName: { type: String, required: true, trim: true },

    /** Gross payment amount (paisa) on which withholding was calculated */
    grossAmount: { type: Number, required: true, min: 0 },

    /** Withholding rate applied (%) */
    rate: { type: Number, required: true, min: 0 },

    /** Withholding amount (paisa) */
    withholdingAmount: { type: Number, required: true, min: 0 },

    /** Net amount paid after deduction (paisa) */
    netPaid: { type: Number, required: true, min: 0 },

    /** Reference to the source invoice / vendor bill (polymorphic String per PACKAGE_RULES §7) */
    sourceId: { type: String, default: null },
    sourceModel: { type: String, default: null },

    /** Reference to the journal entry that posted the withholding */
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', default: null },

    /** NBR challan number (deposit slip when amount is remitted to NBR) */
    challanNumber: { type: String, trim: true, default: null },
    challanDate: { type: Date, default: null },

    /** Whether this certificate has been reconciled against a return filing */
    reconciled: { type: Boolean, default: false },
    reconciledAt: { type: Date, default: null },

    /** For TDS: section of Income Tax Ordinance (e.g. 's52', 's52A') */
    tdsSection: { type: String, trim: true, default: null },

    /** For VDS: service category from the VDS matrix */
    vdsServiceCategory: { type: String, trim: true, default: null },

    notes: { type: String, trim: true, default: null },
  },
  {
    timestamps: true,
    collection: 'withholding_certificates',
  },
);

// Query: list all certificates for a branch in a period
withholdingCertificateSchema.index({ organizationId: 1, period: 1, type: 1 });
// Query: find by certificate number
withholdingCertificateSchema.index(
  { certificateNumber: 1 },
  { unique: true, partialFilterExpression: { certificateNumber: { $type: 'string' } } },
);
// Query: unreconciled certificates for return filing
withholdingCertificateSchema.index({ organizationId: 1, reconciled: 1, type: 1 });
// Query: by counterparty for statement
withholdingCertificateSchema.index({ organizationId: 1, counterpartyTin: 1, period: 1 });

const WithholdingCertificate = mongoose.model('WithholdingCertificate', withholdingCertificateSchema);

export default WithholdingCertificate;
