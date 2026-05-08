/**
 * POS Shift Handlers — thin delegations onto `@classytic/pos`.
 *
 * The package owns the FSM, variance gate, ApprovalChain, policy snapshot,
 * and idempotent atomic writes. This file's only job is host-side:
 *   1. Resolve actor + branch from the fastify request.
 *   2. Translate body shapes into repo-verb inputs.
 *   3. Run the repo verb against `posEngine.repositories.shift`.
 *   4. Map package errors into arc's HTTP error classes.
 *
 * Replaces the previous 560-line file that re-implemented FSM, variance,
 * and ApprovalChain locally — all of that now lives in `@classytic/pos`.
 */

import {
  createDomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@classytic/arc';
import {
  ActiveShiftAlreadyOpenError,
  CashMovementInvalidError,
  IllegalShiftTransitionError,
  PosError,
  ShiftFinalizedError,
  ShiftNotFoundError,
  VarianceExceededError,
  type CashMovementReasonCode,
  type ShiftPaymentMethod,
} from '@classytic/pos';
import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { posEngine } from './pos.engine.js';
import posShiftRepository from './shift.repository.js';
import { CASH_MOVEMENT_REASON_CODES, SHIFT_PAYMENT_METHODS } from './shift.constants.js';
import { ConflictError } from '@classytic/arc/utils';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Actor {
  id: string;
  name: string;
  roles: string[];
}

function getActor(req: FastifyRequest): Actor {
  const user = (req as unknown as { user?: { _id?: unknown; id?: unknown; name?: unknown; role?: unknown } }).user;
  if (!user) throw new UnauthorizedError('Authentication required');
  const id = String(user._id ?? user.id ?? '');
  if (!id) throw new UnauthorizedError('Authentication required');
  const name = typeof user.name === 'string' && user.name.length > 0 ? user.name : id;
  const roles = Array.isArray(user.role) ? (user.role as string[]) : typeof user.role === 'string' ? [user.role] : [];
  return { id, name, roles };
}

/**
 * Determine the branch this request operates on. Accepts the standard
 * `x-organization-id` header; falls back to the user's session-level org.
 * Validates membership for non-admin callers (prevents cross-branch reach).
 */
async function resolveShiftBranch(req: FastifyRequest): Promise<string> {
  const headerOrg = (req.headers['x-organization-id'] as string | undefined) ?? undefined;
  const user = (req as unknown as { user?: { _id?: unknown; id?: unknown; role?: unknown; organizationId?: unknown; orgId?: unknown } }).user;
  if (!user) throw new UnauthorizedError('Authentication required');
  const userId = user._id ?? user.id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  const sessionOrg = (user.organizationId ?? user.orgId) as string | undefined;
  const orgId = headerOrg?.trim() || sessionOrg;
  if (!orgId) throw new ValidationError('Missing organization — pass x-organization-id or set active branch');

  const platformRoles = Array.isArray(user.role) ? (user.role as string[]) : typeof user.role === 'string' ? [user.role] : [];
  const isAdmin = platformRoles.some((r) => r === 'admin' || r === 'superadmin');

  if (headerOrg && !isAdmin) {
    if (!mongoose.Types.ObjectId.isValid(orgId)) throw new ValidationError('Invalid organization ID');
    const member = await mongoose.connection
      .getClient()
      .db()
      .collection('member')
      .findOne({
        userId: String(userId),
        organizationId: new mongoose.Types.ObjectId(orgId),
      });
    if (!member) throw new ForbiddenError('Not a member of the requested branch');
  }

  return orgId;
}

function ctxFrom(req: FastifyRequest, branchId: string, actor: Actor) {
  return {
    organizationId: branchId,
    actorId: actor.id,
    roles: actor.roles,
  };
}

/**
 * Load a shift and verify it belongs to the caller's branch. Prevents
 * cross-branch tampering via a known shift _id. Mongoose returns null
 * when the org doesn't match (multi-tenant plugin), but the spec wants a
 * 403 for "wrong branch", not 404. We probe unscoped here to distinguish.
 */
async function loadShiftForBranch(
  shiftId: string,
  branchId: string,
): Promise<{ shift: import('@classytic/pos').IShift & { _id: unknown }; sameBranch: true }> {
  const shift = await posEngine.models.Shift.findById(shiftId).lean();
  if (!shift) throw new NotFoundError('PosShift', shiftId);
  if (String((shift as { organizationId: unknown }).organizationId) !== String(branchId)) {
    throw new ForbiddenError('Shift belongs to a different branch');
  }
  return { shift: shift as never, sameBranch: true };
}

interface BeProdShiftPolicy {
  requiredOpeningFloat?: number | null;
  allowHandover?: boolean;
  blindCloseRequired?: boolean;
  allowedReasonCodes?: readonly string[];
  managerOverrideRequired?: boolean;
  varianceThresholdAbs?: number;
  varianceThresholdPct?: number;
  autoCloseTimezone?: string;
}

/**
 * Translate a `PosError` thrown by the package into the matching arc HTTP
 * error class. Codes propagate so clients can branch on them.
 */
function rethrowAsArcError(err: unknown): never {
  if (err instanceof ShiftNotFoundError) {
    throw new NotFoundError('PosShift', err.message);
  }
  if (err instanceof ActiveShiftAlreadyOpenError) {
    throw createDomainError('ACTIVE_SHIFT_ALREADY_OPEN', err.message, 409);
  }
  if (err instanceof IllegalShiftTransitionError) {
    throw createDomainError('SHIFT_STATE_CONFLICT', err.message, 409);
  }
  if (err instanceof ShiftFinalizedError) {
    throw createDomainError('SHIFT_FINALIZED', err.message, 409);
  }
  if (err instanceof VarianceExceededError) {
    // 403 — policy denial (matches the legacy host's response code so
    // existing FE/test contracts stay green). The structured payload still
    // carries the numeric details for clients that surface them.
    throw createDomainError('VARIANCE_EXCEEDED', err.message, 403, {
      difference: err.difference,
      expected: err.expected,
    });
  }
  if (err instanceof CashMovementInvalidError) {
    throw new ValidationError(err.message);
  }
  if (err instanceof PosError) {
    throw createDomainError(err.code, err.message, 400);
  }
  throw err;
}

/**
 * Lazy-close stale shifts on a register before opening a new one.
 * Replaces the orphan-shift cron with just-in-time recovery. The package's
 * LedgerBridge fires inside forceClose so the JE still posts.
 */
async function closeStaleShiftsOnRegister(
  branchId: string,
  registerId: string,
  todayUtc: Date,
  req: FastifyRequest,
): Promise<void> {
  const stale = await posEngine.models.Shift.find({
    organizationId: branchId,
    registerId,
    state: { $in: ['open', 'paused', 'blind_closed'] },
    businessDate: { $lt: todayUtc },
  })
    .select('_id')
    .lean();
  if (stale.length === 0) return;
  for (const s of stale) {
    try {
      await posEngine.repositories.shift.forceClose(String(s._id), {
        organizationId: branchId,
        actorId: 'system:lazy-close',
      });
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, shiftId: String(s._id), branchId, registerId },
        'lazy-close: forceClose failed; oversight will surface for manual close',
      );
    }
  }
}

function bdBusinessDate(timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getCurrentShift(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const branchId = await resolveShiftBranch(req);
  const shift = await posShiftRepository.getActiveShift(branchId);
  reply.send(shift);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export async function openShift(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const registerId = (body.registerId as string | undefined) ?? branchId; // single-register-per-branch default
  const openingCash = Number(body.openingCash ?? 0);
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    throw new ValidationError('openingCash must be a non-negative number');
  }

  // Resolve policy via the bridge so businessDate matches branch timezone
  // and host-policy fields (requiredOpeningFloat, autoCloseTimezone) apply.
  const policy = (await posEngine.bridges.policy!.resolvePolicy(
    ctxFrom(req, branchId, actor),
  )) as BeProdShiftPolicy;

  // Host-policy gate — package can't enforce this (the value isn't a
  // package primitive). Reject opens that don't match the branch's
  // mandatory opening float.
  if (
    typeof policy.requiredOpeningFloat === 'number' &&
    policy.requiredOpeningFloat !== openingCash
  ) {
    throw new ValidationError(
      `openingCash must be ${policy.requiredOpeningFloat} for this branch policy`,
    );
  }

  const businessDate = bdBusinessDate(policy.autoCloseTimezone ?? 'Asia/Dhaka');

  // Lazy-close any stale shift on this register before opening a new one.
  // Replaces the orphan-shift cron: stale recovery fires inline on next
  // open, so registers that *are* used never carry yesterday's shift
  // forward. Permanently-abandoned registers stay on the oversight
  // dashboard for manager force-close. The package's LedgerBridge emits
  // the JE during forceClose; per-shift errors are logged + non-fatal so
  // a downstream JE blip never blocks the cashier from opening a shift.
  await closeStaleShiftsOnRegister(branchId, registerId, businessDate, req);

  try {
    const shift = await posEngine.repositories.shift.open(
      {
        registerId,
        businessDate,
        openingCashierId: actor.id,
        openingCashierName: actor.name,
        openingCash,
        ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      },
      ctxFrom(req, branchId, actor),
    );
    reply.status(201).send(shift);
  } catch (err) {
    // Active-shift collision can land here three ways: the package's typed
    // error, raw Mongo `code: 11000`, or mongokit's translated duplicate-
    // value Error whose message begins "Duplicate value for organizationId".
    // All three mean "an active shift already exists for this branch".
    const message = err instanceof Error ? err.message : '';
    const isCollision =
      err instanceof ActiveShiftAlreadyOpenError ||
      (err as { code?: number })?.code === 11000 ||
      /^Duplicate value for/.test(message);
    if (isCollision) {
      const existing = await posShiftRepository.getActiveShift(branchId);
      throw createDomainError('ACTIVE_SHIFT_ALREADY_OPEN', err instanceof Error ? err.message : 'An active shift already exists for this branch', 409);
      return;
    }
    rethrowAsArcError(err);
  }
}

// ─── Stripe-style actions (POST /:id/action) ────────────────────────────────

export async function pauseAction(id: string, _data: Record<string, unknown>, req: FastifyRequest) {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  const { shift } = await loadShiftForBranch(id, branchId);
  const policy = (shift as { policySnapshot?: BeProdShiftPolicy }).policySnapshot ?? {};
  if (policy.allowHandover === false) {
    throw new ForbiddenError('Shift handover (pause) is disabled by branch policy');
  }
  try {
    return await posEngine.repositories.shift.pause(id, ctxFrom(req, branchId, actor));
  } catch (err) {
    rethrowAsArcError(err);
  }
}

export async function resumeAction(id: string, _data: Record<string, unknown>, req: FastifyRequest) {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  await loadShiftForBranch(id, branchId); // branch-isolation guard
  try {
    return await posEngine.repositories.shift.resume(id, ctxFrom(req, branchId, actor));
  } catch (err) {
    rethrowAsArcError(err);
  }
}

function recordCashMovement(direction: 'in' | 'out') {
  return async (id: string, data: Record<string, unknown>, req: FastifyRequest) => {
    const branchId = await resolveShiftBranch(req);
    const actor = getActor(req);
    const amount = Number(data.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError('amount must be a positive number');
    }
    const reasonCode = data.reasonCode as CashMovementReasonCode | undefined;
    if (!reasonCode || !CASH_MOVEMENT_REASON_CODES.includes(reasonCode)) {
      throw new ValidationError(`reasonCode is required (one of: ${CASH_MOVEMENT_REASON_CODES.join(', ')})`);
    }

    // Branch isolation + policy check — load the shift's frozen policy and
    // gate against the per-branch allowlist of reason codes.
    const { shift } = await loadShiftForBranch(id, branchId);
    const policy = (shift as { policySnapshot?: BeProdShiftPolicy }).policySnapshot ?? {};
    if (
      Array.isArray(policy.allowedReasonCodes) &&
      policy.allowedReasonCodes.length > 0 &&
      !policy.allowedReasonCodes.includes(reasonCode)
    ) {
      throw new ValidationError(`reasonCode '${reasonCode}' is not allowed at this branch`);
    }

    // Cash-out drawer-balance guard — host concern (the package allows
    // negative drawer balances; finance teams want explicit rejection).
    if (direction === 'out') {
      const cashRow = ((shift as { paymentBreakdown?: Array<{ method: string; openingAmount: number; cashInAmount: number; cashOutAmount: number; salesAmount: number; refundAmount: number }> }).paymentBreakdown ?? [])
        .find((r) => r.method === 'cash');
      if (cashRow) {
        const drawer = cashRow.openingAmount + cashRow.salesAmount - cashRow.refundAmount + cashRow.cashInAmount - cashRow.cashOutAmount;
        if (amount > drawer) {
          throw new ValidationError(`cash-out ${amount} exceeds drawer balance ${drawer}`);
        }
      }
    }

    try {
      return await posEngine.repositories.shift.recordCashMovement(
        {
          shiftId: id,
          movement: {
            type: direction,
            amount,
            reasonCode,
            note: typeof data.note === 'string' ? data.note : '',
            cashierId: actor.id,
            cashierName: actor.name,
          },
        },
        ctxFrom(req, branchId, actor),
      );
    } catch (err) {
      rethrowAsArcError(err);
    }
  };
}

export const cashInAction = recordCashMovement('in');
export const cashOutAction = recordCashMovement('out');

interface ReconcileBody {
  /**
   * Per-method counts. Two field names are accepted for backward
   * compatibility with the SDK (which historically used `counts`):
   *   - `countedByMethod` — canonical, matches the package input shape.
   *   - `counts` — legacy, same array shape; translated below.
   */
  countedByMethod?: Array<{ method: ShiftPaymentMethod; countedAmount: number }>;
  counts?: Array<{ method: ShiftPaymentMethod; countedAmount: number }>;
  countedCash?: number;
  notes?: string;
  /** Modern explicit shape. */
  varianceOverride?: { overriddenBy: string; reason: string };
  /** Legacy single-string shorthand. Translated to varianceOverride below. */
  managerOverrideReason?: string;
}

function deriveOverride(body: ReconcileBody, actor: Actor): { overriddenBy: string; reason: string } | undefined {
  if (body.varianceOverride) return body.varianceOverride;
  if (typeof body.managerOverrideReason === 'string' && body.managerOverrideReason.trim().length > 0) {
    return { overriddenBy: actor.id, reason: body.managerOverrideReason.trim() };
  }
  return undefined;
}

function bodyToCountedByMethod(data: ReconcileBody): Partial<Record<ShiftPaymentMethod, number>> {
  const out: Partial<Record<ShiftPaymentMethod, number>> = {};
  // Accept either the canonical field or the SDK's legacy `counts` alias.
  const methodCounts = Array.isArray(data.countedByMethod)
    ? data.countedByMethod
    : Array.isArray(data.counts)
      ? data.counts
      : null;
  if (methodCounts) {
    for (const c of methodCounts) {
      if (!SHIFT_PAYMENT_METHODS.includes(c.method)) {
        throw new ValidationError(`Unknown payment method: ${c.method}`);
      }
      out[c.method] = c.countedAmount;
    }
  } else if (typeof data.countedCash === 'number') {
    out.cash = data.countedCash;
  }
  return out;
}

export async function blindCloseAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  await loadShiftForBranch(id, branchId); // branch-isolation guard
  const body = data as ReconcileBody;
  const countedByMethod = bodyToCountedByMethod(body);
  if (Object.keys(countedByMethod).length === 0) {
    throw new ValidationError('countedByMethod or countedCash is required');
  }
  try {
    return await posEngine.repositories.shift.blindClose(
      {
        shiftId: id,
        countedByMethod,
        closingCashierId: actor.id,
        closingCashierName: actor.name,
        ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      },
      ctxFrom(req, branchId, actor),
    );
  } catch (err) {
    rethrowAsArcError(err);
  }
}

/**
 * Reconcile = manager-driven close (after blind_close). Same package verb
 * as `closeShiftAction` — reconcile is just the manager-led path that
 * provides counts + an optional override row. Four-eyes: the manager
 * MUST be a different user than the cashier who blind-closed.
 */
export async function reconcileAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  const { shift } = await loadShiftForBranch(id, branchId);
  const body = data as ReconcileBody;

  // Four-eyes: reconciler must differ from the user who blind-closed.
  const blindCloser = (shift as { closingCashierId?: string | null }).closingCashierId;
  if (blindCloser && String(blindCloser) === String(actor.id)) {
    throw new ForbiddenError('Four-eyes: reconcile must be performed by a different user than the blind-close');
  }

  try {
    return await posEngine.repositories.shift.close(
      {
        shiftId: id,
        countedByMethod: bodyToCountedByMethod(body),
        closedBy: 'manager',
        ...(deriveOverride(body, actor) ? { varianceOverride: deriveOverride(body, actor)! } : {}),
      },
      ctxFrom(req, branchId, actor),
    );
  } catch (err) {
    rethrowAsArcError(err);
  }
}

export async function closeShiftAction(id: string, data: Record<string, unknown>, req: FastifyRequest) {
  const branchId = await resolveShiftBranch(req);
  const actor = getActor(req);
  const { shift } = await loadShiftForBranch(id, branchId);
  const body = data as ReconcileBody;
  const counted = bodyToCountedByMethod(body);
  const policy = (shift as { policySnapshot?: BeProdShiftPolicy }).policySnapshot ?? {};
  const state = (shift as { state?: string }).state;

  // Host-policy gate: branches that mandate blind_close → reconcile cannot
  // skip straight to direct close from `open`.
  if (policy.blindCloseRequired === true && state === 'open') {
    throw new ValidationError(
      'This branch requires blind-close → reconcile; direct close is not permitted',
    );
  }

  // FSM nuance: a `blind_closed` shift transitions to `closed` only via
  // `reconcile` (manager-led). The cashier's `close` action on a blind-
  // closed shift is rejected so the four-eyes flow is honored.
  if (state === 'blind_closed') {
    throw createDomainError(
      'SHIFT_STATE_CONFLICT',
      'Shift is blind_closed; use the reconcile action to close',
      409,
    );
  }

  const override = deriveOverride(body, actor);
  // When an override is present, the close is manager-led; closedBy
  // reflects that so reports surface manager activity correctly.
  const closedBy = override ? 'manager' : 'cashier';

  try {
    return await posEngine.repositories.shift.close(
      {
        shiftId: id,
        ...(Object.keys(counted).length > 0 ? { countedByMethod: counted } : {}),
        closedBy,
        ...(override ? { varianceOverride: override } : {}),
      },
      ctxFrom(req, branchId, actor),
    );
  } catch (err) {
    rethrowAsArcError(err);
  }
}
