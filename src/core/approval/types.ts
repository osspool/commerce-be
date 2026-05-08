/**
 * Cross-cutting approval framework — types.
 *
 * The `ApprovalChain` value object lives in `@classytic/primitives/approval`
 * (pure VO + state-transition functions, no I/O). This module owns the
 * be-prod layer: the matrix policy, the action preset, and the resolver
 * that turns a (subjectType, evaluation context) pair into a chain template.
 *
 * Design split:
 *   - primitives/approval = engine (mechanism)
 *   - core/approval       = framework (be-prod-specific glue)
 *   - resources/approval  = REST surface for managing policies
 *   - <subject>.resource  = thin opt-in via `withApprovalChain(...)`
 *
 * Subjects (PO, journal entry, invoice, budget, scrap, transfer, audit, …)
 * embed an `approvals` subdocument (canonical name per `PACKAGE_RULES.md
 * §P7`) and gate their terminal action (`post`, `approve`, `close`, …)
 * on `isApproved(doc.approvals)`. The
 * chain itself does not fire side effects — that stays in the subject's
 * existing terminal handler so quirks (period locks, receive flow, credit
 * limits) are not pulled into the framework.
 */

import type {
  ApprovalChain,
  ChainOrder,
  CreateChainInput,
} from '@classytic/primitives/approval';

/**
 * Stable identifier for a class of document that can be approved.
 * Matches the discriminator persisted on `ApprovalPolicy.subjectType` and
 * the `subjectType` argument of `withApprovalChain(...)`.
 *
 * Add new values as subjects opt in. Kept as a string union (not enum) so
 * downstream packages can extend without an arc-style augmentation dance.
 */
export type ApprovalSubjectType =
  | 'purchase_order'
  | 'journal_entry'
  | 'invoice'
  | 'budget'
  | 'stock_adjustment'
  | 'stock_transfer'
  | 'stock_audit'
  | 'stock_scrap'
  | 'discount'
  | 'payment'
  | 'expense_claim'
  | (string & {});

/**
 * Ordered comparison ops for policy conditions. ALL conditions on a policy
 * must evaluate true for the policy to match (AND semantics). For OR
 * semantics, define multiple policies — first match wins, ranked by
 * `priority` desc.
 */
export type ConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'in' | 'nin';

export interface PolicyCondition {
  /** Field path on the evaluation context (e.g. `amount`, `category`). */
  readonly field: string;
  readonly op: ConditionOp;
  /** Single value for ordered ops; array for `in`/`nin`. */
  readonly value: number | string | boolean | ReadonlyArray<number | string>;
}

/**
 * Approver slot in a chain template. Resolved into concrete user IDs at
 * submit time.
 *
 *   - `userIds`: literal list — wins over role expansion when set.
 *   - `roles`:   org-roles to expand against branch members.
 *   - `requiredApprovals`: quorum (default 1).
 */
export interface ChainStepTemplate {
  readonly id: string;
  readonly name?: string;
  readonly userIds?: readonly string[];
  readonly roles?: readonly string[];
  readonly requiredApprovals?: number;
}

export interface ChainTemplate {
  readonly order: ChainOrder;
  readonly steps: readonly ChainStepTemplate[];
}

/**
 * Snapshot a subject hands the resolver. Whatever subjects need to match
 * policies on — amount, category, branchId, custom flags. `branchId` is
 * always present (single-tenant multi-branch invariant).
 */
export interface EvaluationContext {
  readonly branchId: string;
  readonly amount?: number;
  readonly category?: string;
  readonly [extra: string]: unknown;
}

/**
 * Resolves an org role to concrete user IDs in a branch. Pluggable so the
 * core/approval module stays decoupled from Better Auth — wired at boot
 * (see `bootstrap-approvals.ts`) by the auth-aware caller.
 */
export type RoleResolver = (input: {
  readonly role: string;
  readonly branchId: string;
}) => Promise<ReadonlyArray<{ readonly id: string; readonly name?: string }>>;

export interface ResolvedChain {
  readonly chain: ApprovalChain;
  readonly policyId: string | null;
  readonly policyVersion: number | null;
}

export type { ApprovalChain, ChainOrder, CreateChainInput };
