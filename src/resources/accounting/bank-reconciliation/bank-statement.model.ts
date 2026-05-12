import mongoose from 'mongoose';

const { Schema } = mongoose;

const statementLineSchema = new Schema(
  {
    date: { type: Date, required: true },
    description: { type: String, trim: true, default: '' },
    /** Funds received from bank (inflow — bank credits our account) */
    debit: { type: Number, default: 0, min: 0 },
    /** Funds sent to bank (outflow — bank debits our account) */
    credit: { type: Number, default: 0, min: 0 },
    /** Cheque / transaction reference from the bank */
    reference: { type: String, trim: true, default: null },
    /** Set when this line is matched to a JE item */
    matchingNumber: { type: String, default: null },
    jeEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    jeItemIndex: { type: Number, default: null },
  },
  { _id: true },
);

const bankStatementSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'organization', required: true, index: true },
    /** Account in the CoA that represents this bank account (e.g. 1111 Cash) */
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    /** Denormalised account code for quick lookups */
    bankAccountCode: { type: String, trim: true, required: true },
    statementDate: { type: Date, required: true },
    openingBalance: { type: Number, default: 0 },
    closingBalance: { type: Number, default: 0 },
    /** Bank's own statement number / reference */
    reference: { type: String, trim: true, default: null },
    status: { type: String, enum: ['draft', 'reconciled'], default: 'draft', index: true },
    lines: { type: [statementLineSchema], default: [] },
  },
  {
    timestamps: true,
    collection: 'bank_statements',
  },
);

bankStatementSchema.index({ organizationId: 1, statementDate: -1 });
bankStatementSchema.index({ organizationId: 1, bankAccountCode: 1, statementDate: -1 });

const BankStatement = mongoose.model('BankStatement', bankStatementSchema);

export default BankStatement;
