/**
 * Journal Entry Action Registry — Stripe-style state transitions
 *
 * Wired via declarative `actions:` block → POST /accounting/journal-entries/:id/action
 *
 * Approval gate (`submit_for_approval` + `decide`) is contributed by the
 * shared `withApprovalChain` preset (`#core/approval`). Replaces the legacy
 * hand-rolled `submit-for-review` / `approve` / `reject` actions and the
 * `JE_APPROVAL_MACHINE` FSM (deleted) — the chain owns "who reviews this"
 * sequencing now, while the host-side `approvalState` field + audit stamps
 * are mirrored via the preset's `onSubmitted` / `onApproved` / `onRejected`
 * hooks so existing list/filter UIs keying off `approvalState` keep working.
 *
 * The kernel-side actions (`post`, `reverse`, `duplicate`, `archive`) stay
 * unchanged. `post` still gates approval-routed JEs — but instead of
 * inspecting the `approvalState` field, it now checks
 * `isApproved(doc.approvals)` per PACKAGE_RULES §P7. When `approvals` is
 * null/undefined the JE is system-generated (auto-posted from POS / RMA /
 * COGS pipelines) and posts freely. The 422 + `JE_NOT_APPROVED` error code
 * is preserved verbatim — clients depend on it.
 */

import { isApproved } from '@classytic/primitives/approval';
import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { requireFinanceAdmin } from '#shared/permissions.js';
import { createDomainError } from '@classytic/arc/utils';
import mongoose from 'mongoose';
import {
  withApprovalChain,
  type ApprovableDoc,
} from '#core/approval/with-approval-chain.js';
import type { Repository } from '@classytic/mongokit';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { JournalEntry, journalEntryRepository } from '../accounting.engine.js';

/**
 * mongokit's `withTransaction` wraps repo errors before they reach arc's
 * `errorHandlerPlugin`, so the original `AccountingError` instance is no
 * longer reachable via `instanceof` at the mapper boundary. Re-throw as
 * an ArcError via `createDomainError(err.code, err.message, err.status)` —
 * the canonical domain code (e.g. `PERIOD_LOCKED_DAILY`,
 * `IMMUTABLE_ENTRY`, `CREDIT_LIMIT_EXCEEDED`) survives.
 *
 * Errors with no `code` / `status` (plain `Error`s) bubble untouched —
 * arc's fallback turns them into `arc.internal_error` 500.
 */
function rethrowDomainError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err && 'status' in err && 'message' in err) {
      const e = err as { code?: unknown; status?: unknown; message?: unknown };
      if (typeof e.code === 'string' && typeof e.status === 'number' && typeof e.message === 'string') {
        throw createDomainError(e.code, e.message, e.status);
      }
    }
    throw err;
  });
}

function getIds(req: RequestWithExtras): { orgId: string | undefined; actorId: string | undefined } {
  const orgId = getOrgId(req.scope) ?? undefined;
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined) as string | undefined;
  return { orgId, actorId };
}

function toObjectId(actorId: string | null): mongoose.Types.ObjectId | null {
  return actorId ? new mongoose.Types.ObjectId(actorId) : null;
}

/**
 * Local typed view of a JournalEntry document. Extends `ApprovableDoc` so
 * the preset reads `doc.approvals` natively. JE's lifecycle field is
 * `state` (not `status`) so we supply `getStatus`.
 */
interface JournalEntryDoc extends ApprovableDoc {
  organizationId?: string;
  state: string;
}

const approvalActions = withApprovalChain<JournalEntryDoc>({
  subjectType: 'journal_entry',
  repository: journalEntryRepository as unknown as Repository<JournalEntryDoc>,
  // Only kernel-state `draft` JEs may enter the approval pipeline. Once
  // posted/archived, approval workflow is irrelevant.
  allowedSubmitStatus: ['draft'],
  getStatus: (doc) => doc.state,
  permissions: {
    submit: requireRoles('admin', 'finance_admin', 'staff'),
    decide: requireFinanceAdmin(),
  },
  toEvaluationContext: (doc) => ({
    branchId: String(doc.organizationId ?? ''),
  }),
  resolveChain: createPolicyChainResolver(),
  onSubmitted: async (doc, ctx) =>
    (await JournalEntry.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      {
        $set: {
          approvalState: 'pending_review',
          submittedBy: toObjectId(ctx.actorId),
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as JournalEntryDoc,
  onApproved: async (doc, ctx) =>
    (await JournalEntry.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      {
        $set: {
          approvalState: 'approved',
          approvedBy: toObjectId(ctx.actorId),
          approvedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    ).lean()) as JournalEntryDoc,
  onRejected: async (doc, decision, ctx) =>
    (await JournalEntry.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      {
        $set: {
          approvalState: 'rejected',
          rejectedBy: toObjectId(ctx.actorId),
          rejectedAt: new Date(),
          rejectionReason: decision.note ?? null,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as JournalEntryDoc,
});

/**
 * Arc 2.8 declarative actions — imported by journal-entry.resource.ts.
 *
 * Period-lock errors (PERIOD_LOCKED, FISCAL_ERROR, FISCAL_PERIOD_CLOSED)
 * are surfaced as 409 (conflict) so clients can distinguish "you tried to
 * post into a closed period" from generic 400 validation failures.
 */
export const journalEntryActions = {
  // Approval gate — submit_for_approval + decide come from the shared preset
  ...approvalActions,

  /**
   * draft → posted.
   *
   * Two gating modes:
   *  - JEs created from internal commerce flows (auto-posted) keep
   *    `approvals = null` and post freely — they're system-generated.
   *  - JEs that opted into the manual-approval workflow (via
   *    `submit_for_approval`) carry an `ApprovalChain`; this action gates on
   *    `isApproved(doc.approvals)` per PACKAGE_RULES §P7. Otherwise we 422 —
   *    finance staff cannot post a JE whose chain is still pending or
   *    rejected.
   */
  post: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      const doc = (await journalEntryRepository.getById(id, {
        organizationId: orgId,
        throwOnNotFound: false,
      })) as { approvals?: unknown } | null;
      if (doc && doc.approvals != null && !isApproved(doc.approvals as Parameters<typeof isApproved>[0])) {
        throw Object.assign(
          new Error(
            `JE post requires an approved chain (use 'submit_for_approval' + 'decide' first).`,
          ),
          { statusCode: 422, code: 'JE_NOT_APPROVED' },
        );
      }
      return rethrowDomainError(journalEntryRepository.post(id, orgId, { actorId }));
    },
    permissions: requireFinanceAdmin(),
  },

  /**
   * posted → posted (creates new counter-entry on `reversalDate`).
   * Original stays posted, marked `reversed=true`. Forward correction.
   */
  reverse: {
    handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      const reversalDate = data.reversalDate ? new Date(data.reversalDate as string) : undefined;
      return rethrowDomainError(journalEntryRepository.reverse(id, orgId, { reversalDate, actorId }));
    },
    permissions: requireFinanceAdmin(),
    schema: {
      type: 'object',
      properties: {
        reversalDate: {
          type: 'string',
          format: 'date',
          description: 'Date for the reversal entry (defaults to today)',
        },
      },
      required: [],
    },
  },

  /** any → new draft (clones items, fresh state, today's date) */
  duplicate: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId } = getIds(req);
      return journalEntryRepository.duplicate(id, orgId);
    },
    permissions: requireRoles('admin', 'finance_admin', 'staff'),
  },

  /**
   * draft → archived. Posted entries cannot be archived (immutable);
   * use `reverse` instead. Preserves audit trail.
   */
  archive: {
    handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
      const { orgId, actorId } = getIds(req);
      return rethrowDomainError(journalEntryRepository.archive(id, orgId, { actorId }));
    },
    permissions: requireRoles('admin'),
  },
};
