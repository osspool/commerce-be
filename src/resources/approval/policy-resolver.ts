/**
 * Policy resolver — bridges `withApprovalChain({ useMatrix: true })` to the
 * `ApprovalPolicy` collection.
 *
 * Given a subjectType + evaluation context (snapshot of the subject's
 * relevant fields — amount, category, branchId, …), the resolver:
 *
 *   1. Lists active policies for the subject ordered by priority desc
 *   2. Filters by branch scope — branch-specific policy beats global one
 *   3. Filters by AND'd conditions on the evaluation context
 *   4. Picks the first match
 *   5. Expands role-based steps into concrete approver IDs via the wired
 *      `RoleResolver` (decoupled from Better Auth — wired at boot)
 *   6. Hands a `CreateChainInput` to `createChain` and returns the chain
 *
 * Wired into the framework via `setRoleResolver(...)` at app boot. The
 * action preset calls `createPolicyChainResolver()` on-demand — no module
 * import-time DB calls.
 */

import { createChain } from '@classytic/primitives/approval';
import type {
  ApprovalSubjectType,
  EvaluationContext,
  ResolvedChain,
  RoleResolver,
} from '#core/approval/types.js';
import { rethrowApprovalError } from '#core/approval/errors.js';
import approvalPolicyRepository from './policy.repository.js';
import type {
  IApprovalPolicy,
  IPolicyCondition,
  IChainStepTemplate,
} from './policy.model.js';

// ─── Role resolver wiring ──────────────────────────────────────────────────

let resolveRole: RoleResolver | null = null;

/**
 * Register the role-resolver implementation. Called once at boot from the
 * auth-aware layer (e.g. a startup hook that closes over the Better Auth
 * client). Keeps `core/approval` decoupled from Better Auth.
 */
export function setRoleResolver(resolver: RoleResolver): void {
  resolveRole = resolver;
}

/**
 * Build the `(subjectType, evalCtx) -> ResolvedChain | null` function the
 * action preset expects. Captures the repository + role resolver in
 * closure scope.
 */
export function createPolicyChainResolver() {
  return async (
    subjectType: ApprovalSubjectType,
    evalCtx: EvaluationContext,
  ): Promise<ResolvedChain | null> => {
    const candidates = await approvalPolicyRepository.listActiveForSubject(
      subjectType,
      evalCtx.branchId,
    );

    const matched = pickPolicy(candidates, evalCtx);
    if (!matched) return null;

    const steps = await Promise.all(
      matched.chainTemplate.steps.map((step) => expandStep(step, evalCtx.branchId)),
    );

    const chain = rethrowApprovalError(() =>
      createChain({
        order: matched.chainTemplate.order,
        steps,
      }),
    );

    return {
      chain,
      policyId: String((matched as unknown as { _id: unknown })._id),
      policyVersion: matched.version ?? 1,
    };
  };
}

// ─── Internals ─────────────────────────────────────────────────────────────

function pickPolicy(
  candidates: IApprovalPolicy[],
  evalCtx: EvaluationContext,
): IApprovalPolicy | null {
  // Already sorted: priority desc, updatedAt desc. Branch-specific entries
  // sit alongside global ones; prefer branch-specific when otherwise tied.
  const matched = candidates.filter((p) => allConditionsMatch(p.conditions, evalCtx));
  if (matched.length === 0) return null;

  // Branch-specific wins over global at equal priority.
  matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aBranchSpecific = a.branchId ? 1 : 0;
    const bBranchSpecific = b.branchId ? 1 : 0;
    return bBranchSpecific - aBranchSpecific;
  });

  return matched[0] ?? null;
}

function allConditionsMatch(
  conditions: IPolicyCondition[] | undefined,
  evalCtx: EvaluationContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evalCondition(c, evalCtx));
}

function evalCondition(condition: IPolicyCondition, evalCtx: EvaluationContext): boolean {
  const actual = (evalCtx as Record<string, unknown>)[condition.field];
  const expected = condition.value;

  switch (condition.op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && (expected as Array<unknown>).includes(actual);
    case 'nin':
      return Array.isArray(expected) && !(expected as Array<unknown>).includes(actual);
    default:
      return false;
  }
}

async function expandStep(step: IChainStepTemplate, branchId: string) {
  const literal = (step.userIds ?? []).map((id) => ({ id }));

  const fromRoles: Array<{ id: string; name?: string }> = [];
  if (step.roles && step.roles.length > 0) {
    if (!resolveRole) {
      throw Object.assign(
        new Error(
          'Role-based approver resolution requested but no RoleResolver is wired. Call setRoleResolver() at app boot.',
        ),
        { code: 'ROLE_RESOLVER_NOT_WIRED' },
      );
    }
    const expansions = await Promise.all(
      step.roles.map((role) => resolveRole!({ role, branchId })),
    );
    for (const list of expansions) {
      for (const u of list) fromRoles.push({ id: u.id, ...(u.name !== undefined ? { name: u.name } : {}) });
    }
  }

  const merged = dedupeById([...literal, ...fromRoles]);
  if (merged.length === 0) {
    throw Object.assign(
      new Error(`Step '${step.id}' resolved to zero approvers — no userIds and no role expansions.`),
      { code: 'EMPTY_APPROVER_EXPANSION' },
    );
  }

  return {
    id: step.id,
    ...(step.name !== undefined ? { name: step.name } : {}),
    approvers: merged,
    requiredApprovals: step.requiredApprovals ?? 1,
  };
}

function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
