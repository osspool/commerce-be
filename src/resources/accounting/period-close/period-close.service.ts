/**
 * Period-Close Service — orchestrates the guided fiscal-period close.
 *
 * Drives a `PeriodCloseSession` through five steps:
 *
 *   validate_drafts   → no draft JEs in the period
 *   trial_balance     → snapshot stored on the step result for audit
 *   bank_reconcile    → manual ack (operator confirms the reconciliation)
 *   close_period      → calls the ledger's atomic closeFiscalPeriod
 *   archive           → marks the session completed
 *
 * Each handler is a pure(-ish) async function `(ctx) => Promise<result>`
 * — no transition logic. Status updates / index advancement live in the
 * repository's `markStepResult`. This keeps the wiring narrow:
 *
 *   resource → service.advance()
 *               ├── handler runs
 *               ├── repo.markStepResult(success | failed)
 *               └── return updated session
 *
 * The advance/skip/start verbs are the only public surface. The wizard
 * UI binds buttons to those three.
 */

import { closeFiscalPeriod } from '@classytic/ledger';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import {
  Account,
  accounting,
  bdPack,
  FiscalPeriod,
  fiscalPeriodRepository,
  JournalEntry,
} from '../accounting.engine.js';
import {
  DEFAULT_PERIOD_CLOSE_STEPS,
  type PeriodCloseSessionDoc,
  type PeriodCloseStepKey,
} from './period-close.model.js';
import { periodCloseSessionRepository } from './period-close.repository.js';

interface StepContext {
  session: PeriodCloseSessionDoc;
  periodId: string;
  actorId?: string;
}

interface FiscalPeriodLite {
  _id: mongoose.Types.ObjectId | string;
  name: string;
  startDate: Date;
  endDate: Date;
  closed?: boolean;
}

async function loadPeriod(periodId: string): Promise<FiscalPeriodLite | null> {
  const doc = await fiscalPeriodRepository.getById(periodId, {
    lean: true,
    throwOnNotFound: false,
  });
  return (doc ?? null) as FiscalPeriodLite | null;
}

/**
 * Step handlers: each receives the running session + period ids and returns
 * a `result` object that gets persisted on the step. Throwing marks the
 * step `failed` — caller can advance again to retry.
 */
const STEP_HANDLERS: Record<
  PeriodCloseStepKey,
  (ctx: StepContext) => Promise<Record<string, unknown> | undefined>
> = {
  validate_drafts: async ({ periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const draftCount = await JournalEntry.countDocuments({
      state: 'draft',
      date: { $gte: period.startDate, $lte: period.endDate },
    });
    if (draftCount > 0) {
      throw Object.assign(
        new Error(
          `${draftCount} draft journal entr${draftCount === 1 ? 'y' : 'ies'} in this period must be posted or archived before close.`,
        ),
        { code: 'PERIOD_HAS_DRAFTS', draftCount },
      );
    }
    return { draftCount: 0 };
  },

  trial_balance: async ({ periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    // biome-ignore lint/suspicious/noExplicitAny: ledger report surface is loose
    const tb: any = await (accounting.reports as any).trialBalance({
      dateOption: 'asOf',
      dateValue: period.endDate,
    });
    const totalDebit = Number(tb?.totals?.debit ?? 0);
    const totalCredit = Number(tb?.totals?.credit ?? 0);
    return {
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit,
      asOf: period.endDate,
      rowCount: Array.isArray(tb?.rows) ? tb.rows.length : 0,
    };
  },

  bank_reconcile: async () => {
    // Manual-ack step. The handler always succeeds; the FE sends an ack
    // payload via `advance({ ack: true })`. Skipping this step requires a
    // documented reason (audited).
    return { acknowledged: true };
  },

  /**
   * Settlement reconciliation gate — every imported gateway/COD statement
   * dated in the period must have `status: 'reconciled'`. An unreconciled
   * import means a clearing-account leg hasn't been pinned to its sales JE,
   * so the closed period would carry mystery clearing balances forward.
   */
  validate_settlements: async ({ session, periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const filter: Record<string, unknown> = {
      status: { $ne: 'reconciled' },
      statementDate: { $gte: period.startDate, $lte: period.endDate },
    };
    if (orgId) filter.organizationId = new mongoose.Types.ObjectId(String(orgId));
    const SettlementImport = mongoose.connection.db?.collection('settlement_imports');
    if (!SettlementImport) return { skipped: 'no settlement collection' };
    const unreconciledCount = await SettlementImport.countDocuments(filter);
    if (unreconciledCount > 0) {
      throw Object.assign(
        new Error(
          `${unreconciledCount} settlement import${unreconciledCount === 1 ? '' : 's'} in this period are unreconciled. Match all legs before closing.`,
        ),
        { code: 'PERIOD_HAS_UNRECONCILED_SETTLEMENTS', unreconciledCount },
      );
    }
    return { unreconciledCount: 0 };
  },

  /**
   * Clearing-account zero-out gate — gateway / mobile-money / COD / GR-IR
   * clearing accounts must net to zero at period end. A non-zero clearing
   * balance means cash is in flight: an in-transit gateway payout, an
   * un-recorded courier remittance, or a vendor receipt without a matched
   * bill. Closing the period locks that limbo into the next fiscal year.
   */
  validate_clearing_balance: async ({ periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    // Clearing accounts: gateway 1125, mobile-money 1126, COD 1127, GR-IR
    // 2114 (if seeded). Sum debit−credit per account up to period end.
    const CLEARING_CODES = ['1125', '1126', '1127', '2114'];
    const accounts = await Account.find({ accountTypeCode: { $in: CLEARING_CODES } })
      .select('_id accountTypeCode')
      .lean();
    if (accounts.length === 0) return { skipped: 'no clearing accounts seeded' };
    const accountIds = accounts.map((a) => a._id as mongoose.Types.ObjectId);
    const rows = await JournalEntry.aggregate<{
      _id: mongoose.Types.ObjectId;
      debit: number;
      credit: number;
    }>([
      { $match: { state: 'posted', date: { $lte: period.endDate } } },
      { $unwind: '$journalItems' },
      { $match: { 'journalItems.account': { $in: accountIds } } },
      {
        $group: {
          _id: '$journalItems.account',
          debit: { $sum: { $ifNull: ['$journalItems.debit', 0] } },
          credit: { $sum: { $ifNull: ['$journalItems.credit', 0] } },
        },
      },
    ]);
    const offending = rows
      .map((r) => {
        const acc = accounts.find((a) => String(a._id) === String(r._id));
        return { code: acc?.accountTypeCode, balance: r.debit - r.credit };
      })
      .filter((r) => Math.abs(r.balance) >= 1); // 1 paisa tolerance for rounding
    if (offending.length > 0) {
      throw Object.assign(
        new Error(
          `Clearing accounts not zero at period end: ${offending.map((o) => `${o.code}=${o.balance}`).join(', ')}. Reconcile in-flight clearings before closing.`,
        ),
        { code: 'PERIOD_CLEARING_NOT_ZERO', offending },
      );
    }
    return { clearingAccountsChecked: accounts.length, allZero: true };
  },

  /**
   * Costing gate — sales JEs flagged with `metadata.costMissing: true` must
   * be backfilled before close. The flag is set by the cost-layer service
   * when a sale runs against insufficient layers (zero-stock or partial
   * layers); without a backfill the period closes with under-stated COGS.
   */
  validate_costing: async ({ periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const uncostedCount = await JournalEntry.countDocuments({
      state: 'posted',
      date: { $gte: period.startDate, $lte: period.endDate },
      'metadata.costMissing': true,
    });
    if (uncostedCount > 0) {
      throw Object.assign(
        new Error(
          `${uncostedCount} sales journal entr${uncostedCount === 1 ? 'y has' : 'ies have'} cost layers missing (metadata.costMissing). Backfill cost layers and re-run costing before close.`,
        ),
        { code: 'PERIOD_HAS_UNCOSTED_SALES', uncostedCount },
      );
    }
    return { uncostedCount: 0 };
  },

  /**
   * POS shift gate — no shift may be in an active state with a businessDate
   * inside the period. An open shift means a register hasn't been counted
   * and the daily POS aggregation JE for that day hasn't been posted, so
   * cash + revenue for that day are not yet on the books.
   */
  validate_open_pos_shifts: async ({ session, periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const ACTIVE_STATES = ['open', 'paused', 'blind_closed'];
    const Shifts = mongoose.connection.db?.collection('shifts');
    if (!Shifts) return { skipped: 'no shifts collection' };
    const filter: Record<string, unknown> = {
      state: { $in: ACTIVE_STATES },
      businessDate: { $gte: period.startDate, $lte: period.endDate },
    };
    if (orgId) filter.organizationId = new mongoose.Types.ObjectId(String(orgId));
    const openCount = await Shifts.countDocuments(filter);
    if (openCount > 0) {
      throw Object.assign(
        new Error(
          `${openCount} POS shift${openCount === 1 ? ' is' : 's are'} still open in this period. Close all registers before closing the fiscal period.`,
        ),
        { code: 'PERIOD_HAS_OPEN_POS_SHIFTS', openCount },
      );
    }
    return { openCount: 0 };
  },

  /**
   * Negative-stock gate — closing the period freezes inventory valuation, so
   * any quant with `quantityOnHand < 0` would lock a phantom liability into
   * the closed books. Negative on-hand means a sale was committed against
   * stock that didn't exist (timing bug, missing receipt, mis-keyed POS),
   * and the cost is being pulled from layers that shouldn't be there.
   *
   * Reads `flow_stock_quants` directly — Flow's authoritative on-hand
   * collection. We can't import the Flow engine here without a circular
   * dep, but the collection shape is stable per @classytic/flow.
   */
  validate_negative_stock: async ({ session }) => {
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const Quants = mongoose.connection.db?.collection('flow_stock_quants');
    if (!Quants) return { skipped: 'no flow_stock_quants collection' };
    const filter: Record<string, unknown> = { quantityOnHand: { $lt: 0 } };
    if (orgId) filter.organizationId = new mongoose.Types.ObjectId(String(orgId));
    const rows = await Quants.find(filter, {
      projection: { skuRef: 1, locationId: 1, quantityOnHand: 1 },
      limit: 25,
    }).toArray();
    if (rows.length > 0) {
      const summary = rows
        .slice(0, 5)
        .map((r) => `${r.skuRef}@${r.locationId}=${r.quantityOnHand}`)
        .join(', ');
      throw Object.assign(
        new Error(
          `${rows.length} stock quant${rows.length === 1 ? ' has' : 's have'} negative on-hand (e.g. ${summary}). Investigate missing receipts or unwind the offending sales before closing.`,
        ),
        { code: 'PERIOD_HAS_NEGATIVE_STOCK', sample: rows.slice(0, 25) },
      );
    }
    return { negativeQuantCount: 0 };
  },

  /**
   * Withholding-certificate gate — every issued (Mushak 6.6) and received
   * cert dated in the period must be reconciled to its underlying VDS/TDS
   * payable/receivable JE. An unreconciled issued cert means we owe NBR
   * but the payable line isn't tagged; an unreconciled received cert means
   * we have a claimable VAT credit that won't appear on Mushak 9.1 line 15.
   */
  validate_withholding: async ({ session, periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const Certs = mongoose.connection.db?.collection('withholdingcertificates');
    if (!Certs) return { skipped: 'no withholding-certificate collection' };
    const filter: Record<string, unknown> = {
      reconciledAt: null,
      certificateDate: { $gte: period.startDate, $lte: period.endDate },
    };
    if (orgId) filter.organizationId = new mongoose.Types.ObjectId(String(orgId));
    const unreconciledCount = await Certs.countDocuments(filter);
    if (unreconciledCount > 0) {
      throw Object.assign(
        new Error(
          `${unreconciledCount} withholding certificate${unreconciledCount === 1 ? '' : 's'} in this period are unreconciled. Match each to its VDS/TDS journal entry before closing.`,
        ),
        { code: 'PERIOD_HAS_UNRECONCILED_WITHHOLDING', unreconciledCount },
      );
    }
    return { unreconciledCount: 0 };
  },

  /**
   * Mushak 6.3 coverage gate — every fulfilled order in the period must have
   * a Mushak 6.3 invoice generated against it. NBR requires a Mushak for
   * every taxable supply; missing invoices mean we under-reported output VAT
   * for the month and can't close cleanly. The auto-bridge generates these
   * on `accounting:order.fulfilled`, but failures (seller BIN missing,
   * fiscal-position rejection, retries that never ran) leave gaps.
   */
  validate_mushak: async ({ session, periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const Orders = mongoose.connection.db?.collection('orders');
    if (!Orders) return { skipped: 'no orders collection' };
    const orderFilter: Record<string, unknown> = {
      fulfillmentStatus: 'fulfilled',
      $or: [
        { fulfilledAt: { $gte: period.startDate, $lte: period.endDate } },
        // Older orders that pre-date `fulfilledAt` fall back to `confirmedAt`.
        { fulfilledAt: { $exists: false }, confirmedAt: { $gte: period.startDate, $lte: period.endDate } },
      ],
    };
    if (orgId) orderFilter.organizationId = new mongoose.Types.ObjectId(String(orgId));

    // Left-join orders → musok_invoices on (sourceModel='Order', sourceId=order._id).
    // The unmatched bucket is what fails the gate.
    const missing = await Orders.aggregate<{ _id: mongoose.Types.ObjectId; orderNumber?: string }>([
      { $match: orderFilter },
      {
        $lookup: {
          from: 'musokinvoices',
          let: { oid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$sourceModel', 'Order'] },
                    { $eq: ['$sourceId', '$$oid'] },
                    { $ne: ['$status', 'cancelled'] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'mushak',
        },
      },
      { $match: { mushak: { $size: 0 } } },
      { $project: { _id: 1, orderNumber: 1 } },
      { $limit: 50 },
    ]).toArray();

    if (missing.length > 0) {
      const sample = missing
        .slice(0, 5)
        .map((o) => o.orderNumber ?? String(o._id))
        .join(', ');
      throw Object.assign(
        new Error(
          `${missing.length} fulfilled order${missing.length === 1 ? '' : 's'} in this period have no Mushak 6.3 (e.g. ${sample}). Backfill via /accounting/musok/generate-from-order before closing.`,
        ),
        { code: 'PERIOD_HAS_MISSING_MUSHAK', sample: missing },
      );
    }
    return { missingMushakCount: 0 };
  },

  /**
   * Open-returns gate — unresolved RMAs in the period block close.
   *
   * An open RMA (requested / approved / received / inspected) means the COGS
   * reversal and refund journal entries have not been posted yet, so closing
   * the period would seal incomplete P&L and inventory balances. The operator
   * must resolve or explicitly skip (with a documented reason) before close.
   *
   * Queries `rmas` directly (no engine import) — same pattern as
   * `validate_open_pos_shifts`. Scoped by organizationId when available.
   */
  validate_open_returns: async ({ session, periodId }) => {
    const period = await loadPeriod(periodId);
    if (!period) throw new Error(`Period ${periodId} not found`);
    const orgId = (session as { organizationId?: unknown } | undefined)?.organizationId;
    const Rmas = mongoose.connection.db?.collection('rmas');
    if (!Rmas) return { skipped: 'no rmas collection' };
    // RMA_OPEN_STATES: requested, approved, received, inspected
    const OPEN_STATES = ['requested', 'approved', 'received', 'inspected'];
    const filter: Record<string, unknown> = {
      state: { $in: OPEN_STATES },
      deletedAt: null,
      $or: [
        { createdAt: { $gte: period.startDate, $lte: period.endDate } },
        { updatedAt: { $gte: period.startDate, $lte: period.endDate } },
      ],
    };
    if (orgId) filter.organizationId = new mongoose.Types.ObjectId(String(orgId));
    const openCount = await Rmas.countDocuments(filter);
    if (openCount > 0) {
      throw Object.assign(
        new Error(
          `${openCount} open RMA${openCount === 1 ? '' : 's'} in this period must be resolved or rejected before close. Unresolved returns have pending COGS reversal and refund entries.`,
        ),
        { code: 'PERIOD_HAS_OPEN_RMAS', openCount },
      );
    }
    return { openRmaCount: 0 };
  },

  close_period: async ({ periodId, actorId }) => {
    const result = await closeFiscalPeriod(
      {
        AccountModel: Account,
        JournalEntryModel: JournalEntry,
        FiscalPeriodModel: FiscalPeriod,
        country: bdPack,
      },
      { periodId, ...(actorId ? { closedBy: actorId } : {}) },
    );
    return result as unknown as Record<string, unknown>;
  },

  archive: async () => {
    return { archivedAt: new Date() };
  },
};

/** Start a new session for a period. Aborts any prior in-progress session. */
export async function startSession(input: {
  periodId: string;
  startedBy?: string;
}): Promise<PeriodCloseSessionDoc> {
  const period = await loadPeriod(input.periodId);
  if (!period) {
    throw Object.assign(new Error(`Period ${input.periodId} not found`), {
      statusCode: 404,
      code: 'PERIOD_NOT_FOUND',
    });
  }
  if ((period as { closed?: boolean }).closed) {
    throw Object.assign(new Error('Period is already closed.'), {
      statusCode: 409,
      code: 'PERIOD_ALREADY_CLOSED',
    });
  }

  // Auto-abort any prior in-progress session for this period.
  await periodCloseSessionRepository.updateMany(
    { periodId: new mongoose.Types.ObjectId(input.periodId), status: 'in_progress' },
    { $set: { status: 'aborted', completedAt: new Date() } },
  );

  const steps = DEFAULT_PERIOD_CLOSE_STEPS.map((s) => ({
    ...s,
    status: 'pending' as const,
  }));

  const created = await periodCloseSessionRepository.create({
    periodId: new mongoose.Types.ObjectId(input.periodId),
    periodLabel: period.name,
    status: 'in_progress',
    steps,
    currentStepIndex: 0,
    startedAt: new Date(),
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
  });
  return created;
}

/** Run the next step. Returns the updated session. */
export async function advanceSession(
  sessionId: string,
  options: { actorId?: string } = {},
): Promise<PeriodCloseSessionDoc> {
  const session = await periodCloseSessionRepository.getById(sessionId);
  if (!session) {
    throw Object.assign(new Error('Session not found'), { statusCode: 404 });
  }
  if (session.status !== 'in_progress') {
    throw Object.assign(new Error(`Session is ${session.status} — cannot advance`), {
      statusCode: 409,
      code: 'SESSION_NOT_IN_PROGRESS',
    });
  }
  const idx = session.currentStepIndex;
  if (idx >= session.steps.length) {
    return session; // already complete; subsequent advance is a no-op
  }

  const step = session.steps[idx];
  if (!step) {
    throw new Error(`Internal: step index ${idx} out of bounds`);
  }
  await periodCloseSessionRepository.markStepRunning(sessionId, step.key);

  try {
    const result = await STEP_HANDLERS[step.key]({
      session,
      periodId: String(session.periodId),
      ...(options.actorId ? { actorId: options.actorId } : {}),
    });
    const updated = await periodCloseSessionRepository.markStepResult(
      sessionId,
      idx,
      'success',
      {
        ...(result !== undefined ? { result } : {}),
        ...(options.actorId ? { decidedBy: options.actorId } : {}),
      },
    );
    return updated ?? session;
  } catch (err) {
    const message = (err as Error).message ?? 'Step failed';
    logger.warn(
      { sessionId, stepKey: step.key, err: message },
      'period-close step failed',
    );
    const updated = await periodCloseSessionRepository.markStepResult(
      sessionId,
      idx,
      'failed',
      {
        error: message,
        ...(options.actorId ? { decidedBy: options.actorId } : {}),
      },
    );
    return updated ?? session;
  }
}

/** Skip the current step with a reason (audited). */
export async function skipCurrentStep(
  sessionId: string,
  reason: string,
  options: { actorId?: string } = {},
): Promise<PeriodCloseSessionDoc> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw Object.assign(new Error('reason is required to skip a step'), {
      statusCode: 400,
      code: 'SKIP_REASON_REQUIRED',
    });
  }

  const session = await periodCloseSessionRepository.getById(sessionId);
  if (!session) {
    throw Object.assign(new Error('Session not found'), { statusCode: 404 });
  }
  if (session.status !== 'in_progress') {
    throw Object.assign(new Error(`Session is ${session.status} — cannot skip`), {
      statusCode: 409,
    });
  }
  const idx = session.currentStepIndex;
  if (idx >= session.steps.length) return session;

  const updated = await periodCloseSessionRepository.markStepResult(
    sessionId,
    idx,
    'skipped',
    {
      skipReason: trimmed,
      ...(options.actorId ? { decidedBy: options.actorId } : {}),
    },
  );
  return updated ?? session;
}

/** Abort an in-progress session — no further advance allowed. */
export async function abortSession(sessionId: string): Promise<PeriodCloseSessionDoc | null> {
  return periodCloseSessionRepository.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(sessionId), status: 'in_progress' },
    { $set: { status: 'aborted', completedAt: new Date() } },
  );
}
