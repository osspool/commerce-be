/**
 * SettlementImport — daily payout / remittance statement from a payment
 * provider (Stripe, SSLCommerz, bKash merchant, Pathao COD courier, etc.).
 *
 * The clearing-account model (1125 Gateway / 1126 Mobile Money / 1127 COD)
 * accumulates one credit per customer payment; this collection captures the
 * matching debit batch when the provider finally remits the float to our
 * bank. Each `SettlementImport` posts a single journal entry on accept:
 *
 *   Dr 1113 Cash at Bank          (totalNet — what hit our account)
 *   Dr 6328 Bank Charges          (totalFee — provider deduction, if any)
 *   Cr 1125 / 1126 / 1127         (totalGross — drains the clearing balance)
 *
 * Per-leg traceability lives in `legs[]`; the GL aggregates by statement
 * (Stripe Tax / Xero / QBO pattern). Legs are matched to the original sale
 * JEs by external txn ref, supporting the "where's my money" aging report.
 *
 * One row per (provider, statementDate, externalRef) per branch — unique
 * index prevents double-import from the same CSV / API replay.
 */

import mongoose, { type HydratedDocument, Schema } from 'mongoose';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SettlementProvider =
  | 'stripe'
  | 'sslcommerz'
  | 'shurjopay'
  | 'bkash'
  | 'nagad'
  | 'rocket'
  | 'pathao'
  | 'redx'
  | 'steadfast'
  | 'manual';

export type SettlementStatus = 'pending' | 'posted' | 'reconciled' | 'cancelled';
export type SettlementSource = 'csv' | 'api' | 'manual';
export type LegMatchState = 'unmatched' | 'auto' | 'manual';
/**
 * Which signal the matcher used to claim a JE for this leg. `gateway_txn_id`
 * is the deterministic tier (matched on a gateway-issued transaction id stored
 * on the JE metadata); `amount_date` is the heuristic fallback. Persisted for
 * audit so finance can prove how a match was made — never user-overrideable.
 */
export type LegMatchStrategy = 'gateway_txn_id' | 'amount_date';

export interface ISettlementLeg {
  _id?: mongoose.Types.ObjectId;
  externalTxnRef: string;
  externalSettlementRef?: string;
  /** paisa — gross customer payment (matches the original clearing-account credit). */
  gross: number;
  /** paisa — provider's processing fee / courier commission. */
  fee: number;
  /**
   * paisa — unrecoverable shortfall on this leg. COD partial collection,
   * marketplace deduction the platform won't reimburse, etc. Posts to
   * `BD.badDebt` (6702). Defaults to 0; gross = net + fee + writeoff.
   */
  writeoff?: number;
  /** paisa — what landed in the bank for this leg (gross - fee - writeoff). */
  net: number;
  /** When the customer paid (provider-supplied). */
  txnDate: Date;
  /** When this leg actually settled to the bank. */
  settlementDate: Date;
  matchState: LegMatchState;
  matchedJournalEntryId?: mongoose.Types.ObjectId;
  matchedJournalItemIndex?: number;
  matchedAt?: Date;
  /** Which strategy the matcher used — populated together with matchState='auto'. */
  matchStrategy?: LegMatchStrategy;
  /** Provider-specific metadata (Stripe charge id, bKash trx_id, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ISettlementImport {
  _id?: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  provider: SettlementProvider;
  /** '1125' | '1126' | '1127' — which clearing account this statement clears. */
  clearingAccountCode: string;
  /** Bank account the net amount lands in. Defaults to BD.cash (1113). */
  bankAccountCode: string;
  /** Fee account for the provider deduction. Defaults to BD.bankCharges (6328). */
  feeAccountCode: string;
  /** Date the provider settled the batch (statement date). */
  statementDate: Date;
  /** Provider's payout/batch identifier. Required for dedup. */
  externalRef: string;
  status: SettlementStatus;
  source: SettlementSource;
  legs: ISettlementLeg[];
  /** Sum of legs[].gross — what we expect to drain from clearing. */
  totalGross: number;
  /** Sum of legs[].fee. */
  totalFee: number;
  /** Sum of legs[].writeoff. */
  totalWriteoff: number;
  /** Sum of legs[].net — what hits the bank. */
  totalNet: number;
  /**
   * Account code for shortfall write-offs. Defaults to `BD.badDebt` (6702).
   * Surfaced on the parent so the posting contract knows where to debit
   * without re-resolving per-leg.
   */
  writeoffAccountCode: string;
  postedJournalEntryId?: mongoose.Types.ObjectId;
  postedAt?: Date;
  postedBy?: mongoose.Types.ObjectId;
  reconciledAt?: Date;
  uploadedBy?: mongoose.Types.ObjectId;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type SettlementImportDocument = HydratedDocument<ISettlementImport>;

// ─── Subschema: leg ─────────────────────────────────────────────────────────

const legSchema = new Schema<ISettlementLeg>(
  {
    externalTxnRef: { type: String, required: true, trim: true, index: true },
    externalSettlementRef: { type: String, trim: true },
    gross: { type: Number, required: true, min: 0 },
    fee: { type: Number, required: true, min: 0, default: 0 },
    writeoff: { type: Number, required: true, min: 0, default: 0 },
    net: { type: Number, required: true },
    txnDate: { type: Date, required: true },
    settlementDate: { type: Date, required: true },
    matchState: {
      type: String,
      enum: ['unmatched', 'auto', 'manual'],
      default: 'unmatched',
      index: true,
    },
    matchedJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    matchedJournalItemIndex: { type: Number, default: null },
    matchedAt: { type: Date, default: null },
    matchStrategy: {
      type: String,
      enum: ['gateway_txn_id', 'amount_date'],
      default: null,
    },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { _id: true, timestamps: false },
);

// ─── Schema ─────────────────────────────────────────────────────────────────

const schema = new Schema<ISettlementImport>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'organization',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: [
        'stripe',
        'sslcommerz',
        'shurjopay',
        'bkash',
        'nagad',
        'rocket',
        'pathao',
        'redx',
        'steadfast',
        'manual',
      ],
      required: true,
      index: true,
    },
    clearingAccountCode: { type: String, required: true, trim: true, index: true },
    bankAccountCode: { type: String, required: true, trim: true },
    feeAccountCode: { type: String, required: true, trim: true },
    writeoffAccountCode: { type: String, required: true, trim: true },
    statementDate: { type: Date, required: true, index: true },
    externalRef: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'posted', 'reconciled', 'cancelled'],
      default: 'pending',
      index: true,
    },
    source: {
      type: String,
      enum: ['csv', 'api', 'manual'],
      default: 'manual',
    },
    legs: { type: [legSchema], default: [] },
    totalGross: { type: Number, required: true, min: 0 },
    totalFee: { type: Number, required: true, min: 0, default: 0 },
    totalWriteoff: { type: Number, required: true, min: 0, default: 0 },
    totalNet: { type: Number, required: true },
    postedJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, default: null },
    reconciledAt: { type: Date, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, collection: 'settlement_imports' },
);

// Dedup: same (org, provider, externalRef) is a re-upload, not a new statement.
schema.index({ organizationId: 1, provider: 1, externalRef: 1 }, { unique: true });
// Aging report drives queries by (clearing, status, statementDate).
schema.index({ organizationId: 1, clearingAccountCode: 1, status: 1, statementDate: -1 });
// Matcher pulls unmatched legs scoped to a branch.
schema.index({ organizationId: 1, 'legs.matchState': 1 });

const SettlementImport = mongoose.model<ISettlementImport>('SettlementImport', schema);

export default SettlementImport;
