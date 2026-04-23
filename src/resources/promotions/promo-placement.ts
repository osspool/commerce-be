/**
 * Promo Placement — authoritative promo lifecycle for order placement.
 *
 * Design principle: the server owns promo math at placement time. The
 * client's `/promotions/evaluate/preview` call is display-only; it does
 * NOT drive anything that mutates state. When an order is placed with
 * `promoCodes`, this module:
 *
 *   1. Calls `engine.evaluate()` on the canonical order lines that the
 *      placement pipeline just resolved — NOT on whatever the client
 *      claims the cart is. Cart-hash tamper is impossible by construction:
 *      the same inputs produce the evaluation, the commit runs in-process
 *      against the same stored reservation.
 *   2. Attaches the evaluation to the order on success (commit).
 *   3. Rolls back the reservation on any downstream failure — order
 *      insert, payment hook, or the commit itself.
 *
 * Why inline, not client-driven:
 *   - Client cannot lie about the discount (server recomputes).
 *   - No cartHash round-tripping (it never leaves the server).
 *   - No preview/evaluate drift (preview is read-only; evaluate happens
 *     once, at the moment of placement, on the canonical inputs).
 *   - Rollback on commit failure is automatic — no orphan reservations.
 *
 * Contract with callers (see `placement.service.ts`):
 *
 *     const reservation = await reservePromo({ codes, lines, subtotal, ctx, logger });
 *     try {
 *       const order = await orderRepo.create({ ..., metadata: { promoEvaluationId: reservation.evaluationId } });
 *       const commit = await commitPromo(reservation, order._id, ctx, logger);
 *       // commit.committed === true on success;
 *       // commit.committed === false + commit.error set on commit failure
 *       // (reservation is already rolled back inside commitPromo).
 *     } catch (err) {
 *       await rollbackPromo(reservation, ctx, logger);
 *       throw err;
 *     }
 */

import type { FastifyBaseLogger } from 'fastify';
import { getPromoEngine } from './promo.plugin.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** Canonical line item shape for the promo engine. Matches `EvaluateInput.items`. */
export interface PromoLineItem {
  productId: string;
  sku: string;
  quantity: number;
  /** Minor units (e.g. paisa for BDT). */
  unitPrice: number;
  lineTotal: number;
}

export interface ReservePromoInput {
  /** Uppercased promo codes submitted by the client. */
  codes: string[] | undefined;
  /** Order lines AFTER server-side catalog resolution — NOT client-claimed. */
  lines: PromoLineItem[];
  /** Subtotal in minor units, computed from `lines`. */
  subtotal: number;
  /** Optional customer ID — enables per-customer usage caps. */
  customerId?: string;
  /** Optional customer tags — enables tag-scoped programs. */
  customerTags?: string[];
  /** Actor performing the placement (user, cashier, or 'system'). */
  actorId: string;
  /** Branch organization ID (BA org) — carried for audit only; promos are company-wide. */
  organizationId?: string;
  /** Logger for structured error + audit reporting. */
  logger?: FastifyBaseLogger | Pick<Console, 'error' | 'info' | 'warn'>;
}

export interface PromoReservation {
  /**
   * Evaluation ID returned by the engine when codes were supplied and
   * matched a program. `undefined` when there are no codes or when every
   * code was rejected (in which case the placement proceeds without
   * discount — rejectedCodes can be surfaced back to the client).
   */
  evaluationId: string | undefined;
  /** Total discount the engine computed, in minor units. */
  totalDiscount: number;
  /** Codes the engine actually applied. */
  appliedCodes: string[];
  /** Codes the engine rejected, with reason — useful for post-placement UX. */
  rejectedCodes: Array<{ code: string; reason: string }>;
}

export interface PromoCommitResult {
  /** True when an evaluation existed AND commit succeeded. */
  committed: boolean;
  /** True when there was no evaluation to commit (no codes / all rejected). */
  skipped: boolean;
  /** Engine error message if commit failed. Reservation is already rolled back. */
  error?: string;
  /** The discount locked to the order, in minor units. */
  totalDiscount?: number;
  /** Codes the engine applied — echoed for client display. */
  appliedCodes?: string[];
  /** Codes the engine rejected — echoed for client display. */
  rejectedCodes?: Array<{ code: string; reason: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────

const LOG_PREFIX = '[promo-placement]';
const SYSTEM_ACTOR_ID = 'system';

// ── Helpers ───────────────────────────────────────────────────────────────

const resolveActorId = (actorId: string | undefined): string =>
  actorId && actorId.trim().length > 0 ? actorId : SYSTEM_ACTOR_ID;

/**
 * Build the promo engine context.
 *
 * Promos are company-wide (see `promo.resources.ts` and the `tenant: false`
 * engine boot). Passing `organizationId` would make the repos inject a
 * per-branch filter on reads — programs seeded at company level would
 * become invisible to branch-scoped calls.
 *
 * The `organizationId` arriving into these helpers is carried only for
 * audit logging (which branch triggered the commit), never forwarded to
 * the engine itself.
 */
const buildCtx = (input: { actorId: string }) => ({ actorId: input.actorId });

/** Canonical line builder for placement pipelines — see `placement.service.ts`. */
export function buildPromoLines(
  resolvedLines: Array<{
    skuRef: string;
    quantity: number;
    snapshot: { productId?: string; unitPrice?: number } | undefined;
  }>,
): PromoLineItem[] {
  return resolvedLines.map((line) => {
    const unitPrice = line.snapshot?.unitPrice ?? 0;
    return {
      productId: line.snapshot?.productId ?? line.skuRef,
      sku: line.skuRef,
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice * line.quantity,
    };
  });
}

/** Subtotal from canonical lines — always drives the engine input. */
export function computePromoSubtotal(lines: PromoLineItem[]): number {
  return lines.reduce((sum, l) => sum + l.lineTotal, 0);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Reserve a promo evaluation for an order-in-flight.
 *
 * Returns an empty reservation (`evaluationId: undefined`) when:
 *   - The client submitted no codes.
 *   - The client submitted codes but every one was rejected.
 *
 * In both cases `rejectedCodes` still lists what failed so the caller can
 * echo it back to the client without any additional engine round-trip.
 */
export async function reservePromo(input: ReservePromoInput): Promise<PromoReservation> {
  const codes = (input.codes ?? []).map((c) => c.toUpperCase()).filter(Boolean);
  if (codes.length === 0) {
    return { evaluationId: undefined, totalDiscount: 0, appliedCodes: [], rejectedCodes: [] };
  }

  const actorId = resolveActorId(input.actorId);
  const ctx = buildCtx({ actorId });

  try {
    const result = await getPromoEngine().services.evaluation.evaluate(
      {
        items: input.lines,
        subtotal: input.subtotal,
        codes,
        customerId: input.customerId,
        customerTags: input.customerTags,
      },
      ctx,
    );

    // If the engine applied nothing (every code was rejected), there is no
    // reservation to commit or roll back. The engine persists a pending
    // record internally regardless — we ignore it (it times out on its own
    // TTL) to keep the caller's state simple.
    const hasApplied = result.appliedCodes.length > 0 && result.totalDiscount > 0;

    return {
      evaluationId: hasApplied ? result.evaluationId : undefined,
      totalDiscount: result.totalDiscount,
      appliedCodes: result.appliedCodes,
      rejectedCodes: result.rejectedCodes,
    };
  } catch (err) {
    // Engine errors during placement are non-fatal — the customer shouldn't
    // lose an order because the promo engine is down. Log and proceed with
    // zero discount. Operators can reconcile via the voucher admin UI.
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn?.(
      { err, codes, actorId, organizationId: input.organizationId },
      `${LOG_PREFIX} reserve failed — continuing placement without discount`,
    );
    return {
      evaluationId: undefined,
      totalDiscount: 0,
      appliedCodes: [],
      rejectedCodes: codes.map((code) => ({ code, reason: `Engine error: ${message}` })),
    };
  }
}

/**
 * Commit a reserved evaluation to an order. Idempotent for empty
 * reservations. On commit failure (voucher exhausted between evaluate and
 * commit, engine error), automatically rolls back the reservation so no
 * drift is left behind.
 */
export async function commitPromo(
  reservation: PromoReservation,
  orderId: string,
  input: { actorId: string; organizationId?: string; logger?: ReservePromoInput['logger'] },
): Promise<PromoCommitResult> {
  if (!reservation.evaluationId) {
    return {
      committed: false,
      skipped: true,
      totalDiscount: 0,
      appliedCodes: reservation.appliedCodes,
      rejectedCodes: reservation.rejectedCodes,
    };
  }

  const actorId = resolveActorId(input.actorId);
  const ctx = buildCtx({ actorId });
  const evaluationId = reservation.evaluationId;

  try {
    await getPromoEngine().services.evaluation.commit(evaluationId, orderId, ctx);
    input.logger?.info?.(
      {
        audit: true,
        op: 'promo.evaluation.commit',
        evaluationId,
        orderId,
        actorId,
        organizationId: input.organizationId,
        totalDiscount: reservation.totalDiscount,
      },
      `${LOG_PREFIX} committed`,
    );
    return {
      committed: true,
      skipped: false,
      totalDiscount: reservation.totalDiscount,
      appliedCodes: reservation.appliedCodes,
      rejectedCodes: reservation.rejectedCodes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.error?.(
      { err, orderId, evaluationId, actorId, organizationId: input.organizationId },
      `${LOG_PREFIX} commit failed — rolling back reservation`,
    );
    // Clean up the orphan reservation so the voucher stays available.
    await rollbackPromo(reservation, { ...input, actorId }).catch(() => {
      /* rollback is best-effort; TTL will clean up if this also fails. */
    });
    return {
      committed: false,
      skipped: false,
      error: message,
      totalDiscount: 0,
      appliedCodes: reservation.appliedCodes,
      rejectedCodes: reservation.rejectedCodes,
    };
  }
}

/**
 * Release a reservation. Call when the surrounding pipeline fails AFTER
 * `reservePromo` but BEFORE `commitPromo` (e.g. order insert throws).
 * Idempotent — safe to call even if the reservation is already gone.
 */
export async function rollbackPromo(
  reservation: PromoReservation,
  input: { actorId: string; organizationId?: string; logger?: ReservePromoInput['logger'] },
): Promise<void> {
  if (!reservation.evaluationId) return;

  const actorId = resolveActorId(input.actorId);
  const ctx = buildCtx({ actorId });

  try {
    await getPromoEngine().services.evaluation.rollback(reservation.evaluationId, ctx);
    input.logger?.info?.(
      {
        audit: true,
        op: 'promo.evaluation.rollback',
        evaluationId: reservation.evaluationId,
        actorId,
        organizationId: input.organizationId,
      },
      `${LOG_PREFIX} rolled back`,
    );
  } catch (err) {
    input.logger?.warn?.(
      { err, evaluationId: reservation.evaluationId, actorId, organizationId: input.organizationId },
      `${LOG_PREFIX} rollback failed — reservation will expire via TTL`,
    );
  }
}
