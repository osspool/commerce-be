/**
 * PeriodCloseSession — durable record of a guided period-close workflow.
 *
 * One session per (period, attempt). Persists the step ladder so an
 * accountant can resume after a reload and audit the order in which
 * steps ran. Drives the "Close Period" wizard in fe-bigboss.
 *
 * Why a model and not just Streamline: the guided sequence is a finance
 * artifact that auditors will ask for ("show me the close run for FY24
 * Q3"). It needs first-class persistence and read-back, not just the
 * durable execution Streamline provides. The session row is the audit
 * artifact; the steps are deterministic and short, so we don't need
 * Streamline's restart-anywhere semantics.
 */

import mongoose from 'mongoose';

export type PeriodCloseStepKey =
  | 'validate_drafts'
  | 'trial_balance'
  | 'bank_reconcile'
  // ── Industry-standard close gates (release-blocker fix). Each one prevents
  // the period from being closed while operational state is still un-pinned:
  // a closed period with unmatched settlements / open shifts / uncosted
  // sales is audit-indefensible. Skipping requires a documented `skipReason`.
  | 'validate_settlements'
  | 'validate_clearing_balance'
  | 'validate_costing'
  | 'validate_negative_stock'
  | 'validate_open_pos_shifts'
  | 'validate_withholding'
  | 'validate_mushak'
  // Open RMAs in the period block close: an unresolved return means pending
  // COGS reversal / refund JEs that haven't hit the books yet, leaving the
  // period P&L and inventory valuation materially incomplete.
  | 'validate_open_returns'
  | 'close_period'
  | 'archive';

export type PeriodCloseStepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

export type PeriodCloseSessionStatus = 'in_progress' | 'completed' | 'aborted';

export interface PeriodCloseStepDoc {
  key: PeriodCloseStepKey;
  /** Human label used by the wizard. */
  label: string;
  status: PeriodCloseStepStatus;
  /** Some steps require a manual ack (bank reconcile) — not blocking, just a checkbox. */
  requiresManualAck?: boolean;
  startedAt?: Date;
  completedAt?: Date;
  /** Free-form result data the step produced (TB snapshot id, draft count, etc.). */
  result?: Record<string, unknown>;
  /** Error message when status==='failed'. */
  error?: string;
  /** Reason given by the operator when status==='skipped'. */
  skipReason?: string;
  /** Operator who advanced or skipped this step. */
  decidedBy?: string;
}

export interface PeriodCloseSessionDoc extends mongoose.Document {
  periodId: mongoose.Types.ObjectId;
  /** Snapshot of the period's name at session start (display-only). */
  periodLabel?: string;
  status: PeriodCloseSessionStatus;
  steps: PeriodCloseStepDoc[];
  /** Index of the next step to run; equals `steps.length` when all done. */
  currentStepIndex: number;
  startedAt: Date;
  completedAt?: Date;
  startedBy?: string;
  /** Aggregate notes — accountant's commentary captured during the run. */
  notes?: string;
}

const stepSchema = new mongoose.Schema<PeriodCloseStepDoc>(
  {
    key: {
      type: String,
      required: true,
      enum: [
        'validate_drafts',
        'trial_balance',
        'bank_reconcile',
        'validate_settlements',
        'validate_clearing_balance',
        'validate_costing',
        'validate_negative_stock',
        'validate_open_pos_shifts',
        'validate_withholding',
        'validate_mushak',
        'validate_open_returns',
        'close_period',
        'archive',
      ],
    },
    label: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'running', 'success', 'skipped', 'failed'],
      default: 'pending',
    },
    requiresManualAck: { type: Boolean },
    startedAt: { type: Date },
    completedAt: { type: Date },
    result: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },
    skipReason: { type: String },
    decidedBy: { type: String },
  },
  { _id: false },
);

const periodCloseSessionSchema = new mongoose.Schema<PeriodCloseSessionDoc>(
  {
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalPeriod', required: true, index: true },
    periodLabel: { type: String },
    status: {
      type: String,
      required: true,
      enum: ['in_progress', 'completed', 'aborted'],
      default: 'in_progress',
      index: true,
    },
    steps: { type: [stepSchema], required: true, default: [] },
    currentStepIndex: { type: Number, required: true, default: 0, min: 0 },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    startedBy: { type: String },
    notes: { type: String },
  },
  { timestamps: true, collection: 'period_close_sessions' },
);

// One active session per period at a time — second start aborts the prior.
// Partial unique enforces this with no impact on completed/aborted history.
periodCloseSessionSchema.index(
  { periodId: 1 },
  { partialFilterExpression: { status: 'in_progress' }, unique: true, name: 'one_inprogress_per_period' },
);

export const PeriodCloseSession =
  (mongoose.models.PeriodCloseSession as mongoose.Model<PeriodCloseSessionDoc>) ||
  mongoose.model<PeriodCloseSessionDoc>('PeriodCloseSession', periodCloseSessionSchema);

/**
 * Default step ladder — pure data so tests can swap it. Order is
 * meaningful; the workflow only advances index by 1.
 */
export const DEFAULT_PERIOD_CLOSE_STEPS: ReadonlyArray<
  Pick<PeriodCloseStepDoc, 'key' | 'label' | 'requiresManualAck'>
> = [
  { key: 'validate_drafts', label: 'Validate no draft journal entries' },
  { key: 'trial_balance', label: 'Run trial balance snapshot' },
  { key: 'bank_reconcile', label: 'Confirm bank reconciliation', requiresManualAck: true },
  // Industry-standard operational gates — must pass before close_period.
  { key: 'validate_settlements', label: 'Confirm all settlement imports reconciled' },
  { key: 'validate_clearing_balance', label: 'Confirm clearing accounts net to zero' },
  { key: 'validate_costing', label: 'Confirm no uncosted sales / cost-missing JEs' },
  { key: 'validate_negative_stock', label: 'Confirm no negative on-hand stock at period end' },
  { key: 'validate_open_pos_shifts', label: 'Confirm no POS shifts open in period' },
  { key: 'validate_withholding', label: 'Confirm withholding certificates reconciled' },
  { key: 'validate_mushak', label: 'Confirm Mushak 6.3 issued for every fulfilled order' },
  { key: 'validate_open_returns', label: 'Confirm no open RMAs in period' },
  { key: 'close_period', label: 'Close fiscal period' },
  { key: 'archive', label: 'Archive close run' },
];
