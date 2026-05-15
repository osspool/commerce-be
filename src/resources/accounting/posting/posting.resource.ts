/**
 * Accounting Posting Resource — oversight + manual recovery for POS shift posting.
 *
 * POS journal entries are emitted by `@classytic/pos`'s LedgerBridge at
 * shift close. Stale shifts are recovered two ways:
 *   1. **Lazy-close on next open** — when a cashier re-opens the register
 *      tomorrow, `shift.handlers.ts:closeStaleShiftsOnRegister` fires
 *      forceClose inline. Covers active registers automatically.
 *   2. **Manual force-close** via this resource — for permanently
 *      abandoned registers a finance admin can force-close from the
 *      oversight dashboard.
 *
 * No background cron. No date-aggregator routes (`/close-day` etc. are gone).
 *
 * Routes:
 *   GET  /accounting/posting/status                  — active shifts for the current branch
 *   GET  /accounting/posting/oversight               — cross-branch active + stale roll-up
 *   POST /accounting/posting/oversight/:shiftId/close — force-close a stale shift (finance_admin)
 */

import { defineResource } from '@classytic/arc';
import { requireOrgMembership } from '@classytic/arc/permissions';
import mongoose from 'mongoose';
import { requireFinanceAdmin } from '#shared/permissions.js';
import { posEngine } from '#resources/sales/pos/pos.engine.js';
import { bdToday } from '#lib/utils/bd-date.js';
import { ConflictError, NotFoundError, ValidationError, createDomainError, createError } from '@classytic/arc/utils';

const branchMember = requireOrgMembership();
const financeAdmin = requireFinanceAdmin();

const postingResource = defineResource({
  name: 'accounting-posting',
  displayName: 'Accounting Posting',
  tag: 'Accounting',
  prefix: '/accounting/posting',
  disableDefaultRoutes: true,

  routes: [
    {
      method: 'GET',
      path: '/status',
      summary: 'Active POS shifts for the current branch',
      description:
        'Returns every shift in an active state (open, paused, blind_closed) for the calling branch — drives the dashboard "registers open now" widget.',
      permissions: branchMember,
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: raw fastify handler
      handler: async (req: any, reply: any) => {
        const orgId = req.scope?.organizationId;
        if (!orgId) {
          throw createDomainError('NO_BRANCH_CONTEXT', 'Organization context required', 400);
        }
        const orgObjectId = mongoose.Types.ObjectId.isValid(orgId)
          ? new mongoose.Types.ObjectId(orgId)
          : orgId;
        const shifts = await posEngine.models.Shift.find({
          organizationId: orgObjectId,
          state: { $in: ['open', 'paused', 'blind_closed'] },
        })
          .select('_id state registerId openingCashierId openedAt blindClosedAt salesCount salesTotal')
          .lean();
        return reply.send({ activeShifts: shifts, currentBdDate: bdToday() });
      },
    },
    {
      method: 'POST',
      path: '/oversight/:shiftId/close',
      summary: 'Force-close a stale shift (manual recovery)',
      description:
        'Finance-admin tool for permanently-abandoned registers — closes the shift, defaults counts to expected (zero variance), and fires the LedgerBridge so the JE still posts. Audit-logged. Not branch-scoped.',
      permissions: financeAdmin,
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: raw fastify handler
      handler: async (req: any, reply: any) => {
        const { shiftId } = req.params as { shiftId: string };
        const body = (req.body ?? {}) as { reason?: string };
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 3) {
          throw createDomainError('REASON_REQUIRED', 'Reason (3+ chars) required for force-close audit trail', 400);
        }

        const shift = await posEngine.models.Shift.findById(shiftId).lean();
        if (!shift) {
          throw new NotFoundError('Shift not found');
        }
        if (['closed', 'orphaned_closed'].includes((shift as { state: string }).state)) {
          throw createDomainError('SHIFT_FINALIZED', 'Shift is already finalized', 409);
        }

        const actor = (req as { user?: { _id?: unknown; id?: unknown; name?: unknown } }).user;
        const actorId = String(actor?._id ?? actor?.id ?? 'system:manual-force-close');
        const branchId = String((shift as { organizationId: unknown }).organizationId);

        try {
          const result = await posEngine.repositories.shift.forceClose(shiftId, {
            organizationId: branchId,
            actorId,
          });
          req.log.info(
            {
              audit: true,
              op: 'pos.shift.force_close.manual',
              shiftId,
              branchId,
              actorId,
              reason,
            },
            'manual force-close',
          );
          return reply.send(result);
        } catch (err) {
          req.log.error(
            { err: (err as Error).message, shiftId, branchId },
            'manual force-close failed',
          );
          throw createError(500, (err as Error).message ?? 'Force-close failed');
        }
      },
    },
    {
      method: 'GET',
      path: '/oversight',
      summary: 'Cross-branch shift posting roll-up',
      description:
        'Per-branch counts of active and stale shifts plus a stale-shift list. Drives the finance director / multi-branch dashboard. Not branch-scoped — admin/finance_admin only.',
      permissions: financeAdmin,
      raw: true,
      // biome-ignore lint/suspicious/noExplicitAny: raw fastify handler
      handler: async (_req: any, reply: any) => {
        const today = bdToday();
        // Treat anything with `businessDate < midnight UTC of today (BD)` as stale.
        const todayUtc = new Date(`${today}T00:00:00.000Z`);

        const db = mongoose.connection.db!;
        const orgs = await db
          .collection('organization')
          .find({}, { projection: { _id: 1, name: 1, slug: 1 } })
          .toArray();

        const stale = await posEngine.repositories.shift.findStaleShifts(todayUtc);

        const orgsById = new Map(orgs.map((o) => [String(o._id), o]));

        // Group stale by branch.
        const staleByBranch = new Map<string, typeof stale>();
        for (const s of stale) {
          const k = String(s.organizationId);
          const list = staleByBranch.get(k) ?? [];
          list.push(s);
          staleByBranch.set(k, list);
        }

        // Active counts per branch (any active state regardless of date).
        const activeAgg = await posEngine.models.Shift.aggregate([
          { $match: { state: { $in: ['open', 'paused', 'blind_closed'] } } },
          { $group: { _id: '$organizationId', count: { $sum: 1 } } },
        ]);
        const activeByBranch = new Map<string, number>(
          activeAgg.map((row: { _id: unknown; count: number }) => [String(row._id), row.count]),
        );

        // Latest closed shift per branch — drives "lastClosedDate" + "daysBehind"
        // on the dashboard. Mirrors the day-close watermark used by
        // period-lock-guard.ts so finance sees the same notion of "closed".
        const lastClosedAgg = await posEngine.models.Shift.aggregate([
          { $match: { state: { $in: ['closed', 'orphaned_closed'] } } },
          {
            $group: {
              _id: '$organizationId',
              lastClosedAt: { $max: '$businessDate' },
            },
          },
        ]);
        const lastClosedByBranch = new Map<string, Date>(
          lastClosedAgg.map((row: { _id: unknown; lastClosedAt: Date }) => [
            String(row._id),
            row.lastClosedAt,
          ]),
        );

        // BD-local "today" as the reference for daysBehind. We compute the
        // calendar-day difference in BD, not raw UTC ms, so a shift closed
        // late last night BD still reports daysBehind=1 even if the wall
        // clock shows >24h elapsed.
        const todayBdMidnight = new Date(`${today}T00:00:00.000+06:00`);
        const MS_PER_DAY = 24 * 60 * 60 * 1000;

        const branches = orgs.map((o) => {
          const id = String(o._id);
          const lastClosedAt = lastClosedByBranch.get(id) ?? null;
          const lastClosedDate = lastClosedAt ? lastClosedAt.toISOString().slice(0, 10) : null;
          const daysBehind = lastClosedAt
            ? Math.max(
                0,
                Math.floor(
                  (todayBdMidnight.getTime() - new Date(`${lastClosedDate}T00:00:00.000+06:00`).getTime()) /
                    MS_PER_DAY,
                ),
              )
            : null;
          return {
            branchId: id,
            // biome-ignore lint/suspicious/noExplicitAny: org collection rows are loosely typed
            branchName: (o as any).name ?? (o as any).slug ?? null,
            activeShifts: activeByBranch.get(id) ?? 0,
            staleShifts: staleByBranch.get(id)?.length ?? 0,
            lastClosedDate,
            daysBehind,
          };
        });

        const totalStale = stale.length;
        const branchesWithStale = branches.filter((b) => b.staleShifts > 0).length;
        const maxDaysBehind = branches.reduce<number>(
          (max, b) => (b.daysBehind != null && b.daysBehind > max ? b.daysBehind : max),
          0,
        );

        return reply.send({
          currentBdDate: today,
          branches,
          staleShifts: stale.map((s) => ({
            shiftId: String(s._id),
            branchId: String(s.organizationId),
            branchName: orgsById.get(String(s.organizationId))?.name ?? null,
            registerId: s.registerId,
            state: s.state,
            businessDate: s.businessDate,
          })),
          summary: {
            totalBranches: branches.length,
            totalStale,
            branchesWithStale,
            maxDaysBehind,
          },
        });
      },
    },
  ],
});

export default postingResource;
