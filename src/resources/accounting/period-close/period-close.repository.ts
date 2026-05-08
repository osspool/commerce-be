/**
 * PeriodCloseSession Repository — extends mongokit Repository.
 *
 * Inherits CRUD, hook pipeline, and pagination. Adds two domain verbs the
 * service uses to drive the wizard: `findInProgress` and `markStepResult`.
 *
 * Step transitions go through `markStepResult` so the only place that
 * mutates `steps[i].status + currentStepIndex` lives in this file. The
 * service composes pre-step validators on top of it.
 */

import { Repository } from '@classytic/mongokit';
import mongoose from 'mongoose';
import {
  PeriodCloseSession,
  type PeriodCloseSessionDoc,
  type PeriodCloseStepKey,
  type PeriodCloseStepStatus,
} from './period-close.model.js';

class PeriodCloseSessionRepository extends Repository<PeriodCloseSessionDoc> {
  constructor() {
    super(PeriodCloseSession, [], { maxLimit: 200 });
  }

  /** Returns the active session for a period, or null. */
  async findInProgress(periodId: string): Promise<PeriodCloseSessionDoc | null> {
    return this.getByQuery({
      periodId: new mongoose.Types.ObjectId(periodId),
      status: 'in_progress',
    });
  }

  /**
   * Atomically mark step `index` with the given status + payload, advance
   * `currentStepIndex` past it (success / skipped only), and complete the
   * session when the last step is done.
   *
   * Updates use the positional `steps.${index}.field` form — never
   * `steps.$[*].field` — so a write to step N never touches step N-1's
   * persisted result data. `currentStepIndex` only advances when the step
   * actually finished; failed steps stay on the same index for retry.
   */
  async markStepResult(
    sessionId: string,
    index: number,
    status: PeriodCloseStepStatus,
    extras: {
      result?: Record<string, unknown>;
      error?: string;
      skipReason?: string;
      decidedBy?: string;
    } = {},
  ): Promise<PeriodCloseSessionDoc | null> {
    if (index < 0 || !Number.isInteger(index)) {
      throw new Error(`markStepResult: invalid index ${index}`);
    }

    const now = new Date();
    const advance = status === 'success' || status === 'skipped';

    const setOps: Record<string, unknown> = {
      [`steps.${index}.status`]: status,
      [`steps.${index}.completedAt`]: now,
    };
    if (extras.result !== undefined) setOps[`steps.${index}.result`] = extras.result;
    if (extras.error !== undefined) setOps[`steps.${index}.error`] = extras.error;
    if (extras.skipReason !== undefined) setOps[`steps.${index}.skipReason`] = extras.skipReason;
    if (extras.decidedBy !== undefined) setOps[`steps.${index}.decidedBy`] = extras.decidedBy;

    const session = await this.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      { $set: setOps },
    );

    if (!session || !advance) return session;

    // Second update — atomic $inc + maybe completion. Splitting the writes
    // keeps the per-step set focused; the increment survives concurrent
    // step edits because Mongo applies $inc atomically against the
    // current persisted value.
    const allDoneNow = index + 1 >= session.steps.length;
    const finalUpdate: Record<string, unknown> = { $inc: { currentStepIndex: 1 } };
    if (allDoneNow) {
      finalUpdate.$set = { status: 'completed', completedAt: now };
    }
    return this.findOneAndUpdate({ _id: session._id }, finalUpdate);
  }

  /**
   * Step-running marker — sets status to 'running' + startedAt on the
   * step matching `key`. Uses arrayFilters because callers know the key
   * but not always the index (e.g. the service walks by key).
   */
  async markStepRunning(sessionId: string, key: PeriodCloseStepKey): Promise<void> {
    // findOneAndUpdate forwards `arrayFilters` to mongoose; mongokit's
    // updateMany filters its option set and drops it. Single-doc mutation
    // here, so findOneAndUpdate is the right verb anyway.
    await this.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      {
        $set: {
          'steps.$[step].status': 'running',
          'steps.$[step].startedAt': new Date(),
        },
      },
      { arrayFilters: [{ 'step.key': key }] },
    );
  }
}

export const periodCloseSessionRepository = new PeriodCloseSessionRepository();
export { PeriodCloseSessionRepository };
