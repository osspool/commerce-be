/**
 * Reusable action preset that contributes `submit_for_approval` + `decide`
 * to a subject's resource definition. Generalises the proven pattern in
 * [resources/inventory/warehouse/procurement/procurement.factory.ts](../../resources/inventory/warehouse/procurement/procurement.factory.ts).
 *
 * Usage in a subject resource:
 *
 *   import { withApprovalChain } from '#core/approval/with-approval-chain.js';
 *
 *   actions: {
 *     ...withApprovalChain({
 *       subjectType: 'budget',
 *       repository: budgetRepository,
 *       allowedSubmitStatus: ['draft', 'rejected'],
 *       permissions: {
 *         submit: permissions.accounting.budgetSubmit,
 *         decide: permissions.accounting.budgetApprove,
 *       },
 *       onApproved: async (doc, ctx) => budgetRepository.transitionTo(doc._id, 'approved', ctx),
 *       onRejected: async (doc, _input, ctx) => budgetRepository.transitionTo(doc._id, 'rejected', ctx),
 *     }),
 *     // subject-specific actions stay here (close, post, reverse, …)
 *   },
 *
 * Two submit modes — caller picks at request time:
 *
 *   - LITERAL chain: `POST /:id/action { action: 'submit_for_approval', chain: {...} }`
 *     FE constructs the chain (procurement today). No policy lookup.
 *
 *   - POLICY-DRIVEN: `POST /:id/action { action: 'submit_for_approval', useMatrix: true }`
 *     Resolver looks up `ApprovalPolicy` by subjectType + evalCtx. Requires
 *     a `resolveChain` fn to be wired (see `policy-resolver.ts`). When unset
 *     and `useMatrix: true`, returns 422.
 *
 * The chain itself does not fire side effects when it flips. The subject's
 * own terminal action (`approve`, `post`, `close`) gates on
 * `isApproved(doc[approvalChainField])` and stays where domain quirks live
 * (period locks, receive flow, credit limits). Optional `onApproved` /
 * `onRejected` hooks here exist only for subjects that want auto-finalise
 * UX — most subjects can leave them undefined.
 */

import {
  applyDecision,
  createChain,
  isApproved,
  isRejected,
  type ApprovalChain,
  type DecisionInput,
} from '@classytic/primitives/approval';
import type { Repository } from '@classytic/mongokit';
import type { PermissionCheck } from '@classytic/arc';
import type { ActionDefinition } from '@classytic/arc/types';
import type { RequestWithExtras } from '@classytic/arc/types';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import { createDomainError, NotFoundError } from '@classytic/arc/utils';
import { rethrowApprovalError, approvalValidationError } from './errors.js';
import type {
  ApprovalSubjectType,
  EvaluationContext,
  ResolvedChain,
} from './types.js';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Minimum surface every approval-bearing subject must expose. Subjects
 * declare a doc interface that extends this (e.g. `interface BudgetDoc
 * extends ApprovableDoc { status: string }`) so the preset can read
 * `doc.approvals` without string-keyed lookups.
 *
 * Field name `approvals` is canonical per `PACKAGE_RULES.md §P7` — every
 * `@classytic/*` package (Budget, JournalEntry, Invoice, ProcurementOrder,
 * StockScrap, StockWave, Quotation, …) exposes it.
 */
export interface ApprovableDoc {
  readonly _id: unknown;
  readonly approvals?: ApprovalChain | null;
}

export interface WithApprovalChainConfig<TDoc extends ApprovableDoc> {
  /** Stable identifier for the subject — must match `ApprovalPolicy.subjectType`. */
  readonly subjectType: ApprovalSubjectType;

  /** MongoKit repository for the subject. */
  readonly repository: Repository<TDoc>;

  /**
   * Status values the subject must be in before `submit_for_approval` is
   * accepted. Skipped when omitted (any state).
   */
  readonly allowedSubmitStatus?: readonly string[];

  /**
   * Reads the lifecycle status off the doc. Default reads `status` —
   * subjects with a different field (e.g. JE's `state`) supply this.
   * Returning `undefined` skips the `allowedSubmitStatus` gate for that
   * doc.
   */
  readonly getStatus?: (doc: TDoc) => string | undefined;

  /** Per-action permission checks. */
  readonly permissions: {
    readonly submit: PermissionCheck;
    readonly decide: PermissionCheck;
  };

  /**
   * Returns the evaluation context the policy resolver matches against.
   * Required when callers use `useMatrix: true` on submit.
   */
  readonly toEvaluationContext?: (doc: TDoc) => EvaluationContext;

  /**
   * Optional. Pluggable resolver for matrix-driven submit. When provided,
   * `useMatrix: true` is honoured. When absent, only literal chains work.
   * Wired by the policy resource (see `policy-resolver.ts`).
   */
  readonly resolveChain?: (
    subjectType: ApprovalSubjectType,
    evalCtx: EvaluationContext,
  ) => Promise<ResolvedChain | null>;

  /**
   * Optional side-effect after a chain is attached on submit. Subjects use
   * this to flip a coarse status field (e.g. budget `draft` → `submitted`)
   * alongside the chain attachment, so existing list/filter UIs that key
   * off `status` keep working. Return the post-side-effect document and it
   * becomes the response payload — return `undefined`/`void` to keep the
   * chain-attached doc as the response.
   */
  readonly onSubmitted?: (doc: TDoc, ctx: PersistContext) => Promise<TDoc | void>;

  /**
   * Optional side-effect when the chain status flips to `approved` after a
   * decision. Subjects that gate terminal actions on `isApproved(chain)`
   * directly (e.g. procurement) can leave this undefined; subjects with
   * coarse status fields (e.g. budget) flip to `approved` here. Return the
   * post-side-effect doc to surface it on the wire; return `undefined` to
   * keep the chain-updated doc.
   */
  readonly onApproved?: (doc: TDoc, ctx: PersistContext) => Promise<TDoc | void>;

  /**
   * Optional side-effect when the chain flips to `rejected`. Receives the
   * triggering decision so the subject can capture the reason on its own
   * audit fields (e.g. `rejectionReason`). Return the post-side-effect doc
   * to surface it on the wire; `undefined` keeps the chain-updated doc.
   */
  readonly onRejected?: (
    doc: TDoc,
    input: DecisionInput,
    ctx: PersistContext,
  ) => Promise<TDoc | void>;
}

export interface PersistContext {
  readonly organizationId: string;
  readonly actorId: string | null;
  readonly requestId: string | undefined;
}

interface SubmitBody {
  readonly chain?: unknown;
  readonly useMatrix?: boolean;
}

interface DecideBody {
  readonly stepId?: string;
  readonly approverId?: string;
  readonly decision?: 'approved' | 'rejected';
  readonly note?: string;
}

/**
 * Build the `{ submit_for_approval, decide }` slice of a resource's
 * `actions:` map. Spread into the resource's actions block.
 */
export function withApprovalChain<TDoc extends ApprovableDoc>(
  config: WithApprovalChainConfig<TDoc>,
): Record<'submit_for_approval' | 'decide', ActionDefinition> {
  return {
    submit_for_approval: {
      handler: async (id, data, req) => submitHandler(config, id, data as SubmitBody, req),
      permissions: config.permissions.submit,
      description: `Attach an approval chain to a ${config.subjectType}. Pass either a literal \`chain\` or \`useMatrix: true\` to resolve from policy.`,
      schema: {
        type: 'object',
        properties: {
          useMatrix: { type: 'boolean', description: 'Resolve chain from ApprovalPolicy matrix.' },
          chain: {
            type: 'object',
            properties: {
              order: { type: 'string', enum: ['sequential', 'parallel'] },
              steps: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['id', 'approvers'],
                  properties: {
                    id: { type: 'string', minLength: 1 },
                    name: { type: 'string' },
                    requiredApprovals: { type: 'integer', minimum: 1 },
                    approvers: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        required: ['id'],
                        properties: {
                          id: { type: 'string', minLength: 1 },
                          name: { type: 'string' },
                          role: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        additionalProperties: false,
      },
    },

    decide: {
      handler: async (id, data, req) => decideHandler(config, id, data as DecideBody, req),
      permissions: config.permissions.decide,
      description: `Apply a single approver decision to the ${config.subjectType}'s active chain step.`,
      schema: {
        type: 'object',
        required: ['stepId', 'approverId', 'decision'],
        properties: {
          stepId: { type: 'string', minLength: 1 },
          approverId: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['approved', 'rejected'] },
          note: { type: 'string', maxLength: 1000 },
        },
        additionalProperties: false,
      },
    },
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function submitHandler<TDoc extends ApprovableDoc>(
  config: WithApprovalChainConfig<TDoc>,
  id: string,
  body: SubmitBody,
  req: RequestWithExtras,
): Promise<unknown> {
  const ctx = persistContext(req);
  const doc = await loadSubject(config.repository, id, ctx, config.subjectType);

  if (config.allowedSubmitStatus) {
    const current = readStatus(config, doc);
    if (!current || !config.allowedSubmitStatus.includes(current)) {
      throw createDomainError(
        'approval.invalid_status_for_submit',
        `Cannot submit ${config.subjectType} for approval in status '${current ?? 'unknown'}'. Must be ${config.allowedSubmitStatus.join(' or ')}.`,
        422,
      );
    }
  }

  // Allow re-submitting after a rejection — the prior chain is terminal
  // and a new attempt should start a fresh chain. Block when the existing
  // chain is `pending` (workflow in flight) or `approved` (already done).
  const existingChain = doc.approvals;
  if (existingChain && existingChain.status !== 'rejected') {
    throw createDomainError(
      'approval.chain_already_attached',
      `Approval chain is already attached and ${existingChain.status}. Cancel or wait for the current workflow first.`,
      409,
    );
  }

  let chain: ApprovalChain;
  let policyId: string | null = null;
  let policyVersion: number | null = null;

  if (body.useMatrix) {
    if (!config.resolveChain || !config.toEvaluationContext) {
      throw createDomainError(
        'approval.matrix_unavailable',
        `Matrix-driven submit not configured for ${config.subjectType}. Provide a literal 'chain' instead.`,
        422,
      );
    }
    const evalCtx = config.toEvaluationContext(doc);
    const resolved = await config.resolveChain(config.subjectType, evalCtx);
    if (!resolved) {
      throw createDomainError(
        'approval.no_matching_policy',
        `No approval policy matched for ${config.subjectType}. Configure one or pass a literal 'chain'.`,
        422,
      );
    }
    chain = resolved.chain;
    policyId = resolved.policyId;
    policyVersion = resolved.policyVersion;
  } else {
    const literal = body.chain;
    if (!literal || typeof literal !== 'object') {
      approvalValidationError('Either `chain` (literal) or `useMatrix: true` is required.');
    }
    chain = rethrowApprovalError(() =>
      createChain(literal as Parameters<typeof createChain>[0]),
    );
  }

  // mongokit's `Repository.update(id, data: Record<string, unknown>, opts)`
  // accepts a flat record — no `Partial<TDoc>` cast needed. Subjects whose
  // schema doesn't declare `approvalPolicyId` / `approvalPolicyVersion`
  // drop them silently (Mongoose strict mode) — intentional.
  const patch: Record<string, unknown> = { approvals: chain };
  if (policyId) patch.approvalPolicyId = policyId;
  if (policyVersion !== null) patch.approvalPolicyVersion = policyVersion;

  const updated = await config.repository.update(id, patch, {
    organizationId: ctx.organizationId,
    lean: true,
  });
  if (!updated) throw new NotFoundError(config.subjectType);

  if (config.onSubmitted) {
    const refined = await config.onSubmitted(updated, ctx);
    if (refined) return refined;
  }

  return updated;
}

async function decideHandler<TDoc extends ApprovableDoc>(
  config: WithApprovalChainConfig<TDoc>,
  id: string,
  body: DecideBody,
  req: RequestWithExtras,
): Promise<unknown> {
  const ctx = persistContext(req);

  if (!body.stepId || !body.approverId || !body.decision) {
    approvalValidationError('stepId, approverId, and decision are required.');
  }

  const doc = await loadSubject(config.repository, id, ctx, config.subjectType);
  const existing = doc.approvals;
  if (!existing) {
    throw createDomainError(
      'approval.no_chain_attached',
      `No approval chain attached to this ${config.subjectType}. Submit one first.`,
      422,
    );
  }

  const decisionInput: DecisionInput = {
    stepId: body.stepId,
    approverId: body.approverId,
    decision: body.decision,
    ...(body.note !== undefined ? { note: body.note } : {}),
  };

  const updatedChain = rethrowApprovalError(() => applyDecision(existing, decisionInput));

  const updated = await config.repository.update(
    id,
    { approvals: updatedChain },
    { organizationId: ctx.organizationId, lean: true },
  );
  if (!updated) throw new NotFoundError(config.subjectType);

  if (isApproved(updatedChain) && !isApproved(existing) && config.onApproved) {
    const refined = await config.onApproved(updated, ctx);
    if (refined) return refined;
  } else if (isRejected(updatedChain) && !isRejected(existing) && config.onRejected) {
    const refined = await config.onRejected(updated, decisionInput, ctx);
    if (refined) return refined;
  }

  return updated;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function persistContext(req: RequestWithExtras): PersistContext {
  const organizationId = getOrgId(req.scope) ?? '';
  if (!organizationId) {
    throw createDomainError(
      'approval.no_organization_context',
      'Branch context (x-organization-id) is required.',
      400,
    );
  }
  const actorId =
    (getUserId(req.scope) as string | null | undefined) ??
    (req.user?._id as string | undefined) ??
    (req.user?.id as string | undefined) ??
    null;
  return { organizationId, actorId, requestId: req.id };
}

function readStatus<TDoc extends ApprovableDoc>(
  config: WithApprovalChainConfig<TDoc>,
  doc: TDoc,
): string | undefined {
  if (config.getStatus) return config.getStatus(doc);
  // Default: read `status` if the subject's doc declares one. Subjects with
  // a different lifecycle field (e.g. JE's `state`) supply `getStatus`.
  const maybe = (doc as { readonly status?: unknown }).status;
  return typeof maybe === 'string' ? maybe : undefined;
}

async function loadSubject<TDoc extends ApprovableDoc>(
  repository: Repository<TDoc>,
  id: string,
  ctx: PersistContext,
  subjectType: ApprovalSubjectType,
): Promise<TDoc> {
  const doc = await repository.getById(id, {
    organizationId: ctx.organizationId,
    throwOnNotFound: false,
    lean: true,
  });
  if (!doc) {
    throw new NotFoundError(`${subjectType} not found`);
  }
  return doc;
}
