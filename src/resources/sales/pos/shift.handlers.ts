/**
 * POS Shift Handlers — open, lifecycle actions, and queries.
 *
 * State machine (see shift.constants.ts):
 *   open ─── pause ──→ paused ─── resume ──→ open
 *   open ─── cash-in / cash-out (no state change) ─→ open
 *   open ─── blind-close ──→ blind_closed ─── reconcile ──→ closed
 *   open ─── close ──→ closed (variance-gated)
 *   * ──── auto-close cron ──→ orphaned_closed (P4)
 */

import { createDomainError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@classytic/arc';
import type { ApprovalChain } from '@classytic/primitives/approval';
import { applyDecision, createChain, isApproved, isRejected } from '@classytic/primitives/approval';
import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import {
  CASH_MOVEMENT_REASON_CODES,
  type CashMovementReasonCode,
  SHIFT_PAYMENT_METHODS,
  type ShiftPaymentMethod,
  type ShiftPolicy,
} from './shift.constants.js';
import PosShift, { type PosShiftDocument } from './shift.model.js';
import posShiftRepository from './shift.repository.js';
import { resolveShiftPolicy, snapshotPolicy } from './shift-policy.resolver.js';

// ============================================================================
// HELPERS
// ============================================================================

/** Derive the business date from a timestamp + IANA timezone (YYYY-MM-DD at 00:00 UTC). */
function toBusinessDate(at: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

interface Actor {
  id: string;
  name: string;
  roles: string[];
}

function getActor(req: FastifyRequest): Actor {
  const user = (req.user ?? {}) as Record<string, unknown>;
  const scope = (req as unknown as { scope?: { orgRoles?: string[] } }).scope;
  const platformRoles = Array.isArray(user.role)
    ? (user.role as string[])
    : typeof user.role === 'string'
      ? [user.role]
      : [];
  return {
    id: (user.id as string | undefined) ?? '',
    name: (user.name as string | undefined) ?? 'Unknown',
    roles: [...platformRoles, ...(scope?.orgRoles ?? [])],
  };
}

/** True for platform admins/superadmins — bypass org-level four-eyes checks. */
function isPlatformAdmin(actor: Actor): boolean {
  return actor.roles.some((r) => r === 'admin' || r === 'superadmin');
}

function addToRoster(shift: PosShiftDocument, actorId: string): void {
  if (actorId && !shift.teamMemberIds.includes(actorId)) {
    shift.teamMemberIds.push(actorId);
  }
}

/**
 * Resolve the target branch for a shift operation.
 *
 * Bearer-auth convention: the token authenticates the USER; the
 * `x-organization-id` header selects which branch this request targets. The
 * BA session's active org is only a fallback for requests that don't specify.
 *
 * Users operating on multiple branches in the same session (e.g. area
 * managers) can switch scope per-request without re-authenticating.
 *
 * Membership is validated against BA's `member` collection so a user can't
 * piggyback on a branch they aren't a member of. Platform admins bypass.
 */
async function resolveShiftBranch(req: FastifyRequest): Promise<string> {
  const user = (req.user ?? {}) as Record<string, unknown>;
  const userId = (user.id as string | undefined) ?? (user._id as string | undefined);
  if (!userId) throw new UnauthorizedError('Unauthenticated');

  const scope = (req as unknown as { scope?: { organizationId?: string } }).scope;
  const headerOrg = req.headers['x-organization-id'] as string | undefined;
  const sessionOrg = scope?.organizationId ?? (user.organizationId as string | undefined);

  // Header wins; session org is the fallback.
  const orgId = headerOrg?.trim() || sessionOrg;
  if (!orgId) {
    throw new ValidationError('Missing organization — pass x-organization-id or set active branch');
  }

  // Platform admins have cross-branch access by design.
  const platformRoles = Array.isArray(user.role)
    ? (user.role as string[])
    : typeof user.role === 'string'
      ? [user.role]
      : [];
  const isAdmin = platformRoles.some((r) => r === 'admin' || r === 'superadmin');

  // When the caller explicitly supplies the header, validate membership so
  // they can't reach a branch they don't belong to. Scope-only requests are
  // already filtered by BA middleware, so skip the extra query.
  if (headerOrg && !isAdmin) {
    if (!mongoose.Types.ObjectId.isValid(orgId)) {
      throw new ValidationError('Invalid organization ID');
    }
    const member = await mongoose.connection
      .getClient()
      .db()
      .collection('member')
      .findOne({
        userId: String(userId),
        organizationId: new mongoose.Types.ObjectId(orgId),
      });
    if (!member) {
      throw new ForbiddenError('Not a member of the requested branch');
    }
  }

  return orgId;
}

/**
 * Load a shift and verify it belongs to the caller's authorized branch.
 * Prevents cross-branch tampering via a known shift _id.
 */
async function loadShift(id: string, req: FastifyRequest): Promise<PosShiftDocument> {
  const branchId = await resolveShiftBranch(req);
  const shift = await PosShift.findById(id);
  if (!shift) throw new NotFoundError('PosShift', id);
  if (String(shift.organizationId) !== String(branchId)) {
    throw new ForbiddenError('Shift belongs to a different branch');
  }
  return shift;
}

function assertState(shift: PosShiftDocument, expected: readonly string[]): void {
  if (!expected.includes(shift.state)) {
    throw createDomainError(
      'SHIFT_STATE_CONFLICT',
      `Shift is ${shift.state}; expected one of [${expected.join(', ')}]`,
      409,
      { state: shift.state, expected },
    );
  }
}

function assertReasonCode(code: string | undefined, policy: ShiftPolicy): asserts code is CashMovementReasonCode {
  if (!policy.requireReasonCode && !code) return;
  if (!code) throw new ValidationError('reasonCode is required');
  if (!CASH_MOVEMENT_REASON_CODES.includes(code as CashMovementReasonCode)) {
    throw new ValidationError(`Unknown reasonCode: ${code}`);
  }
  if (!policy.allowedReasonCodes.includes(code as CashMovementReasonCode)) {
    throw new ValidationError(`reasonCode '${code}' not allowed at this branch`);
  }
}

// ============================================================================
// EXPECTED-CASH CALCULATION
// ============================================================================

/**
 * Compute expected amount per payment method from events on the shift.
 * Uses the Square formula: opening + sales - refunds + cashIn - cashOut.
 * Non-cash methods have no cash movements (cashIn/cashOut are always 0).
 *
 * Note: salesAmount / refundAmount on the breakdown are incremented by the
 * order hook (P3). Until P3 lands they're 0, and expected will reflect only
 * manual cash movements + opening float.
 */
function computeExpected(shift: PosShiftDocument): {
  perMethod: Map<ShiftPaymentMethod, number>;
  expectedCashTotal: number;
} {
  const perMethod = new Map<ShiftPaymentMethod, number>();
  let expectedCashTotal = 0;
  for (const row of shift.paymentBreakdown) {
    const expected = row.openingAmount + row.salesAmount - row.refundAmount + row.cashInAmount - row.cashOutAmount;
    perMethod.set(row.method, expected);
    if (row.method === 'cash') expectedCashTotal = expected;
  }
  return { perMethod, expectedCashTotal };
}

interface CountedPerMethod {
  method: ShiftPaymentMethod;
  countedAmount: number;
}

function writeCounts(
  shift: PosShiftDocument,
  counts: CountedPerMethod[] | undefined,
  countedCash: number | undefined,
): void {
  const { perMethod, expectedCashTotal } = computeExpected(shift);

  // Per-method counts override the scalar countedCash shortcut.
  const countsByMethod = new Map<ShiftPaymentMethod, number>();
  for (const c of counts ?? []) {
    if (!SHIFT_PAYMENT_METHODS.includes(c.method)) {
      throw new ValidationError(`Unknown payment method: ${c.method}`);
    }
    countsByMethod.set(c.method, c.countedAmount);
  }
  if (countedCash !== undefined && !countsByMethod.has('cash')) {
    countsByMethod.set('cash', countedCash);
  }

  for (const row of shift.paymentBreakdown) {
    const expected = perMethod.get(row.method) ?? 0;
    row.expectedAmount = expected;
    const counted = countsByMethod.get(row.method);
    if (counted !== undefined) {
      row.countedAmount = counted;
      row.difference = counted - expected;
    }
  }

  // Denormalized cash totals for quick reporting
  shift.expectedCash = expectedCashTotal;
  const cashCounted = countsByMethod.get('cash');
  if (cashCounted !== undefined) {
    shift.countedCash = cashCounted;
    shift.cashDifference = cashCounted - expectedCashTotal;
  }
}

// ============================================================================
// VARIANCE GATE (Toast pattern)
// ============================================================================

interface VarianceDecision {
  /** True if the current counts are within threshold. */
  withinThreshold: boolean;
  /** Absolute difference at the cash method (what the gate cares about). */
  absoluteDelta: number;
  /** |delta| / expected * 100 — the % figure compared to varianceThresholdPct. */
  percentDelta: number;
}

function evaluateVariance(shift: PosShiftDocument): VarianceDecision {
  const policy = shift.policySnapshot;
  const expected = shift.expectedCash ?? 0;
  const counted = shift.countedCash ?? 0;
  const absoluteDelta = Math.abs(counted - expected);
  const percentDelta = expected === 0 ? 0 : (absoluteDelta / Math.abs(expected)) * 100;
  // `abs OR pct` — more permissive. Matches Toast: small absolute discrepancies
  // pass even when the percentage is high (e.g. 50 BDT on a 300 BDT float).
  // Large discrepancies still require override because abs threshold is breached.
  const withinAbs = absoluteDelta <= policy.varianceThresholdAbs;
  const withinPct = percentDelta <= policy.varianceThresholdPct;
  return { withinThreshold: withinAbs || withinPct, absoluteDelta, percentDelta };
}

function applyVarianceOverride(shift: PosShiftDocument, manager: Actor, reason: string | undefined): void {
  // Four-eyes: cashier cannot approve their own variance. Platform admins
  // (admin / superadmin) bypass this — they're the escalation path of last
  // resort (matches Odoo's accounting_manager group behaviour).
  const isCashier = manager.id === shift.openingCashierId || manager.id === shift.closingCashierId;
  if (isCashier && !isPlatformAdmin(manager)) {
    throw new ForbiddenError('Variance override must be approved by a different user from the cashier');
  }

  const chain: ApprovalChain =
    shift.varianceApproval ??
    createChain({
      order: 'sequential',
      steps: [
        {
          id: 'variance-override',
          name: 'Variance override',
          approvers: [{ id: manager.id, name: manager.name, role: 'manager' }],
          requiredApprovals: 1,
        },
      ],
    });

  const updated = applyDecision(chain, {
    stepId: 'variance-override',
    approverId: manager.id,
    decision: 'approved',
    note: reason ?? '',
    decidedAt: new Date(),
  });

  if (isRejected(updated)) {
    throw new ValidationError('Variance override was rejected');
  }
  if (!isApproved(updated)) {
    throw new Error('Variance override chain did not reach approved state');
  }

  shift.varianceApproval = updated;
}

// ============================================================================
// ROUTES — /pos/shifts/current, /pos/shifts/open
// ============================================================================

export async function getCurrentShift(req: FastifyRequest, reply: FastifyReply) {
  const orgId = await resolveShiftBranch(req);
  const shift = await posShiftRepository.getActiveShift(orgId);
  return reply.send({ success: true, data: shift });
}

export async function openShift(req: FastifyRequest, reply: FastifyReply) {
  const orgId = await resolveShiftBranch(req);

  const actor = getActor(req);
  if (!actor.id) {
    return reply.status(401).send({ success: false, message: 'Unauthenticated' });
  }

  const existing = await posShiftRepository.getActiveShift(orgId);
  if (existing) {
    return reply.status(409).send({
      success: false,
      message: 'An active shift already exists for this branch',
      data: existing,
    });
  }

  const policy = snapshotPolicy(await resolveShiftPolicy(orgId));
  const body = (req.body ?? {}) as { openingCash?: number };
  const openingCash = Number(body.openingCash) || 0;

  if (policy.requiredOpeningFloat !== null && openingCash !== policy.requiredOpeningFloat) {
    return reply.status(400).send({
      success: false,
      message: `Opening float must be ${policy.requiredOpeningFloat} (policy-enforced)`,
    });
  }

  const now = new Date();
  const shift = await PosShift.create({
    organizationId: orgId,
    businessDate: toBusinessDate(now, policy.autoCloseTimezone),
    state: 'open',
    openingCashierId: actor.id,
    openingCashierName: actor.name,
    teamMemberIds: [actor.id],
    openedAt: now,
    openingCash,
    paymentBreakdown: policy.allowedPaymentMethods.map((method) => ({
      method,
      openingAmount: method === 'cash' ? openingCash : 0,
    })),
    policySnapshot: policy,
  });

  return reply.status(201).send({ success: true, data: shift.toObject() });
}

// ============================================================================
// ACTIONS — POST /pos/shifts/:id/action { action, ...data }
// ============================================================================

export async function pauseAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  if (!shift.policySnapshot.allowHandover) {
    throw new ForbiddenError('Handover is disabled for this branch');
  }
  assertState(shift, ['open']);
  shift.state = 'paused';
  shift.pausedAt = new Date();
  shift.endingCashierId = actor.id;
  shift.endingCashierName = actor.name;
  shift.notes = typeof data.notes === 'string' ? data.notes : shift.notes;
  await shift.save();
  return shift.toObject();
}

export async function resumeAction(id: string, _data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  assertState(shift, ['paused']);
  shift.state = 'open';
  shift.resumedAt = new Date();
  addToRoster(shift, actor.id);
  await shift.save();
  return shift.toObject();
}

export async function cashInAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  assertState(shift, ['open']);

  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('amount must be a positive number');
  }

  const reasonCode = typeof data.reasonCode === 'string' ? data.reasonCode : undefined;
  assertReasonCode(reasonCode, shift.policySnapshot);

  shift.cashMovements.push({
    type: 'in',
    amount,
    reasonCode: reasonCode as CashMovementReasonCode,
    note: typeof data.note === 'string' ? data.note : '',
    cashierId: actor.id,
    cashierName: actor.name,
    timestamp: new Date(),
  });
  const cashRow = shift.paymentBreakdown.find((r) => r.method === 'cash');
  if (cashRow) cashRow.cashInAmount += amount;
  addToRoster(shift, actor.id);
  await shift.save();
  return shift.toObject();
}

export async function cashOutAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  assertState(shift, ['open']);

  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('amount must be a positive number');
  }

  const reasonCode = typeof data.reasonCode === 'string' ? data.reasonCode : undefined;
  assertReasonCode(reasonCode, shift.policySnapshot);

  // Drawer sanity: don't let cashiers take out more than expected cash in drawer.
  const { expectedCashTotal } = computeExpected(shift);
  if (amount > expectedCashTotal) {
    throw new ValidationError(`Cash-out ${amount} exceeds drawer balance ${expectedCashTotal}`);
  }

  shift.cashMovements.push({
    type: 'out',
    amount,
    reasonCode: reasonCode as CashMovementReasonCode,
    note: typeof data.note === 'string' ? data.note : '',
    cashierId: actor.id,
    cashierName: actor.name,
    timestamp: new Date(),
  });
  const cashRow = shift.paymentBreakdown.find((r) => r.method === 'cash');
  if (cashRow) cashRow.cashOutAmount += amount;
  addToRoster(shift, actor.id);
  await shift.save();
  return shift.toObject();
}

interface CloseInput {
  counts?: CountedPerMethod[];
  countedCash?: number;
  notes?: string;
  /** Optional up-front manager override; otherwise variance gate blocks. */
  managerOverrideReason?: string;
}

export async function blindCloseAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  if (!shift.policySnapshot.blindCloseRequired) {
    throw new ValidationError('Blind close is not enabled at this branch');
  }
  assertState(shift, ['open']);

  const input = data as CloseInput;
  writeCounts(shift, input.counts, input.countedCash);

  shift.state = 'blind_closed';
  shift.blindClosedAt = new Date();
  shift.closingCashierId = actor.id;
  shift.closingCashierName = actor.name;
  shift.endingCashierId = actor.id;
  shift.endingCashierName = actor.name;
  shift.notes = typeof input.notes === 'string' ? input.notes : shift.notes;
  await shift.save();
  return shift.toObject();
}

export async function reconcileAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  assertState(shift, ['blind_closed']);

  // Four-eyes: reconciling manager ≠ cashier who blind-closed.
  if (actor.id === shift.closingCashierId) {
    throw new ForbiddenError('Reconcile must be performed by a different user from the cashier who blind-closed');
  }

  const input = data as CloseInput;
  // Manager may override cashier counts if disputed.
  if (input.counts || input.countedCash !== undefined) {
    writeCounts(shift, input.counts, input.countedCash);
  }

  const variance = evaluateVariance(shift);
  if (!variance.withinThreshold && shift.policySnapshot.managerOverrideRequired) {
    if (!input.managerOverrideReason) {
      throw new ForbiddenError(`Variance ${variance.absoluteDelta} exceeds threshold; managerOverrideReason required`);
    }
    applyVarianceOverride(shift, actor, input.managerOverrideReason);
  }

  shift.state = 'closed';
  shift.closedAt = new Date();
  shift.closedBy = 'manager';
  if (typeof input.notes === 'string') shift.notes = input.notes;
  addToRoster(shift, actor.id);
  await shift.save();
  return shift.toObject();
}

export async function closeShiftAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const actor = getActor(req);
  const shift = await loadShift(id, req);
  // State check first — a blind_closed / closed shift must reject with 409
  // before the policy validation kicks in.
  assertState(shift, ['open']);
  if (shift.policySnapshot.blindCloseRequired) {
    throw new ValidationError('Branch policy requires blind-close then reconcile');
  }

  const input = data as CloseInput;
  writeCounts(shift, input.counts, input.countedCash);

  const variance = evaluateVariance(shift);
  let closedBy: 'cashier' | 'manager' = 'cashier';
  if (!variance.withinThreshold && shift.policySnapshot.managerOverrideRequired) {
    if (!input.managerOverrideReason) {
      throw new ForbiddenError(`Variance ${variance.absoluteDelta} exceeds threshold; managerOverrideReason required`);
    }
    applyVarianceOverride(shift, actor, input.managerOverrideReason);
    closedBy = 'manager';
  }

  shift.state = 'closed';
  shift.closedAt = new Date();
  shift.closingCashierId = actor.id;
  shift.closingCashierName = actor.name;
  shift.endingCashierId ??= actor.id;
  shift.endingCashierName ??= actor.name;
  shift.closedBy = closedBy;
  if (typeof input.notes === 'string') shift.notes = input.notes;
  addToRoster(shift, actor.id);
  await shift.save();
  return shift.toObject();
}
