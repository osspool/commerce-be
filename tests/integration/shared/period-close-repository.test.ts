/**
 * Repository-level integration tests for `PeriodCloseSessionRepository`.
 *
 * Drives the atomic step-state transitions directly against MongoMemory.
 * The HTTP layer is exercised in `tests/scenarios/accounting/period-close-workflow.test.ts`;
 * here we pin the repository invariants:
 *
 *   - markStepResult('success' | 'skipped') advances currentStepIndex by 1
 *   - markStepResult('failed') does NOT advance — retry is expected
 *   - markStepResult on the LAST step transitions session → 'completed'
 *     and stamps completedAt
 *   - markStepResult preserves prior steps' status (no cross-contamination)
 *   - findInProgress respects the partial-unique constraint
 *   - markStepRunning sets the running flag + startedAt without advancing
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let periodCloseSessionRepository: typeof import('../../src/resources/accounting/period-close/period-close.repository.js').periodCloseSessionRepository;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.COOKIE_SECRET = 'c'.repeat(40);
  process.env.BETTER_AUTH_SECRET = 'd'.repeat(40);
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  ({ periodCloseSessionRepository } = await import(
    '../../../src/resources/accounting/period-close/period-close.repository.js'
  ));
}, 120_000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  await mongoose.connection.collection('period_close_sessions').deleteMany({});
});

async function createSession(overrides: Partial<{ stepCount: number; periodId: string }> = {}) {
  const periodId = overrides.periodId ?? new mongoose.Types.ObjectId().toString();
  const stepCount = overrides.stepCount ?? 5;
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    key: ['validate_drafts', 'trial_balance', 'bank_reconcile', 'close_period', 'archive'][i] ?? 'archive',
    label: `Step ${i + 1}`,
    status: 'pending' as const,
  }));

  const created = await periodCloseSessionRepository.Model.create({
    periodId: new mongoose.Types.ObjectId(periodId),
    status: 'in_progress',
    steps,
    currentStepIndex: 0,
    startedAt: new Date(),
  });
  return { sessionId: String(created._id), periodId };
}

describe('PeriodCloseSessionRepository', () => {
  describe('markStepResult', () => {
    it('advances currentStepIndex by 1 on success', async () => {
      const { sessionId } = await createSession();
      const updated = await periodCloseSessionRepository.markStepResult(sessionId, 0, 'success', {
        result: { draftCount: 0 },
      });
      expect(updated?.currentStepIndex).toBe(1);
      expect(updated?.steps[0]?.status).toBe('success');
      expect(updated?.steps[0]?.result).toMatchObject({ draftCount: 0 });
      expect(updated?.status).toBe('in_progress');
    });

    it('advances currentStepIndex by 1 on skipped (with reason)', async () => {
      const { sessionId } = await createSession();
      const updated = await periodCloseSessionRepository.markStepResult(sessionId, 0, 'skipped', {
        skipReason: 'no activity',
      });
      expect(updated?.currentStepIndex).toBe(1);
      expect(updated?.steps[0]?.status).toBe('skipped');
      expect(updated?.steps[0]?.skipReason).toBe('no activity');
    });

    it('does NOT advance currentStepIndex on failed (retry expected)', async () => {
      const { sessionId } = await createSession();
      const updated = await periodCloseSessionRepository.markStepResult(sessionId, 0, 'failed', {
        error: 'drafts present',
      });
      expect(updated?.currentStepIndex).toBe(0);
      expect(updated?.steps[0]?.status).toBe('failed');
      expect(updated?.steps[0]?.error).toBe('drafts present');
      expect(updated?.status).toBe('in_progress');
    });

    it('marks session completed when the LAST step succeeds', async () => {
      const { sessionId } = await createSession({ stepCount: 3 });
      // Walk the first two steps to set up.
      await periodCloseSessionRepository.markStepResult(sessionId, 0, 'success');
      await periodCloseSessionRepository.markStepResult(sessionId, 1, 'success');

      const final = await periodCloseSessionRepository.markStepResult(sessionId, 2, 'success');
      expect(final?.status).toBe('completed');
      expect(final?.completedAt).toBeTruthy();
      expect(final?.currentStepIndex).toBe(3);
    });

    it('marks session completed when the LAST step is skipped', async () => {
      // Skipping the final step should still complete the session.
      const { sessionId } = await createSession({ stepCount: 2 });
      await periodCloseSessionRepository.markStepResult(sessionId, 0, 'success');
      const final = await periodCloseSessionRepository.markStepResult(sessionId, 1, 'skipped', {
        skipReason: 'archive deferred',
      });
      expect(final?.status).toBe('completed');
      expect(final?.completedAt).toBeTruthy();
    });

    it('preserves earlier-step status when later steps run', async () => {
      const { sessionId } = await createSession({ stepCount: 3 });
      await periodCloseSessionRepository.markStepResult(sessionId, 0, 'success', {
        result: { draftCount: 0 },
      });
      const after1 = await periodCloseSessionRepository.markStepResult(sessionId, 1, 'failed', {
        error: 'TB unbalanced',
      });
      // step 0's success result must NOT have been overwritten by step 1's update.
      expect(after1?.steps[0]?.status).toBe('success');
      expect(after1?.steps[0]?.result).toMatchObject({ draftCount: 0 });
      expect(after1?.steps[1]?.status).toBe('failed');
      expect(after1?.steps[2]?.status).toBe('pending');
    });

    it('records decidedBy on the step when provided', async () => {
      const { sessionId } = await createSession();
      const updated = await periodCloseSessionRepository.markStepResult(sessionId, 0, 'success', {
        decidedBy: 'user-42',
      });
      expect(updated?.steps[0]?.decidedBy).toBe('user-42');
    });

    it('returns null when the session id does not exist', async () => {
      const fake = new mongoose.Types.ObjectId().toString();
      const result = await periodCloseSessionRepository.markStepResult(fake, 0, 'success');
      expect(result).toBeNull();
    });
  });

  describe('markStepRunning', () => {
    it('sets running status + startedAt on the named step without advancing the index', async () => {
      const { sessionId } = await createSession();
      await periodCloseSessionRepository.markStepRunning(sessionId, 'validate_drafts');
      const session = await periodCloseSessionRepository.Model.findById(sessionId);
      const step = session?.steps.find((s) => s.key === 'validate_drafts');
      expect(step?.status).toBe('running');
      expect(step?.startedAt).toBeInstanceOf(Date);
      expect(session?.currentStepIndex).toBe(0); // unchanged
    });
  });

  describe('findInProgress', () => {
    it('returns the active session for a period', async () => {
      const { sessionId, periodId } = await createSession();
      const found = await periodCloseSessionRepository.findInProgress(periodId);
      expect(String(found?._id)).toBe(sessionId);
      expect(found?.status).toBe('in_progress');
    });

    it('returns null when no in-progress session exists', async () => {
      const found = await periodCloseSessionRepository.findInProgress(
        new mongoose.Types.ObjectId().toString(),
      );
      expect(found).toBeNull();
    });

    it('skips completed and aborted sessions', async () => {
      const { sessionId, periodId } = await createSession();
      await periodCloseSessionRepository.Model.updateOne(
        { _id: sessionId },
        { $set: { status: 'completed', completedAt: new Date() } },
      );
      const found = await periodCloseSessionRepository.findInProgress(periodId);
      expect(found).toBeNull();
    });
  });

  describe('partial-unique constraint (one in-progress per period)', () => {
    it('blocks a second in-progress session for the same period', async () => {
      const periodId = new mongoose.Types.ObjectId().toString();
      await createSession({ periodId });

      // Attempting to create a second in-progress for the same period must
      // hit the partial unique index.
      await expect(
        periodCloseSessionRepository.Model.create({
          periodId: new mongoose.Types.ObjectId(periodId),
          status: 'in_progress',
          steps: [],
          currentStepIndex: 0,
          startedAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('permits a fresh in-progress session AFTER the prior one is aborted', async () => {
      const periodId = new mongoose.Types.ObjectId().toString();
      const { sessionId } = await createSession({ periodId });

      // Abort the first.
      await periodCloseSessionRepository.Model.updateOne(
        { _id: sessionId },
        { $set: { status: 'aborted', completedAt: new Date() } },
      );

      // Second now succeeds — partial filter excludes aborted rows.
      const second = await periodCloseSessionRepository.Model.create({
        periodId: new mongoose.Types.ObjectId(periodId),
        status: 'in_progress',
        steps: [],
        currentStepIndex: 0,
        startedAt: new Date(),
      });
      expect(second._id).toBeTruthy();
    });
  });
});
