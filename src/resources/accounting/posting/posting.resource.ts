/**
 * Accounting Posting Resource
 *
 * Manual triggers for accounting day-close and backfill operations.
 * Finance admin and above only. All dates are BD local (YYYY-MM-DD in UTC+6).
 */
import mongoose from 'mongoose';
import { defineResource } from '@classytic/arc';
import { requireAuth, roles } from '@classytic/arc/permissions';
import { publish } from '#lib/events/arcEvents.js';
import { postDailyPosSales } from './aggregation/daily-sales.service.js';
import { bdToday, bdYesterday, toBdDateStr } from '#lib/utils/bd-date.js';
import { JournalEntry } from '../accounting.engine.js';
import { DayCloseState } from './day-close-state.model.js';

const authenticated = requireAuth();

const postingResource = defineResource({
  name: 'accounting-posting',
  displayName: 'Accounting Posting',
  tag: 'Accounting',
  prefix: '/accounting/posting',
  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'POST',
      path: '/close-day',
      summary: 'Close POS books for a specific BD date',
      description: 'Creates one aggregated SALES journal entry for all POS transactions. Idempotent.',
      permissions: authenticated,
      wrapHandler: false,
      schema: {
        body: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'BD local date (YYYY-MM-DD), defaults to yesterday',
            },
          },
        },
      },
      handler: async (req: any, reply: any) => {
        const orgId = req.scope?.organizationId;
        if (!orgId) {
          return reply
            .status(400)
            .send({ success: false, message: 'Organization context required (x-organization-id header)' });
        }

        // Schema validates date format when provided; bdYesterday() is always valid
        const date: string = req.body?.date || bdYesterday();
        const result = await postDailyPosSales(orgId, date);

        if (result.skipped) {
          return reply.send({
            success: true,
            posted: false,
            message: result.reason || 'No POS transactions to post for this date',
            date,
          });
        }

        await publish('accounting:pos.day.close', { branchId: orgId, date });

        return reply.send({
          success: true,
          posted: true,
          journalEntryId: result.journalEntryId,
          date,
          message: `POS day closed for ${date}`,
        });
      },
    },
    {
      method: 'POST',
      path: '/backfill',
      summary: 'Backfill journal entries for a date range',
      description: 'Recovery tool. Processes one day at a time, skips already-posted days. Max 90 days.',
      permissions: authenticated,
      wrapHandler: false,
      schema: {
        body: {
          type: 'object',
          required: ['startDate', 'endDate'],
          properties: {
            startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
      handler: async (req: any, reply: any) => {
        const orgId = req.scope?.organizationId;
        if (!orgId) {
          return reply.status(400).send({ success: false, message: 'Organization context required' });
        }

        const { startDate, endDate } = req.body as { startDate: string; endDate: string };
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) {
          return reply.status(400).send({ success: false, message: 'endDate must be after startDate' });
        }
        if (diffDays > 90) {
          return reply.status(400).send({ success: false, message: 'Max backfill range is 90 days' });
        }

        const results: Array<{ date: string; posted: boolean; journalEntryId?: string; skipped?: boolean }> = [];
        const current = new Date(start);
        while (current <= end) {
          const dateStr = toBdDateStr(current);
          const result = await postDailyPosSales(orgId, dateStr);
          results.push({ date: dateStr, ...result });
          current.setDate(current.getDate() + 1);
        }

        const posted = results.filter((r) => r.posted).length;
        const skipped = results.filter((r) => r.skipped).length;

        return reply.send({
          success: true,
          summary: { processed: results.length, posted, skipped },
          results,
        });
      },
    },
    {
      method: 'GET',
      path: '/oversight',
      summary: 'Cross-branch day-close oversight',
      description:
        'Returns per-branch lastClosedDate, days behind, and a summary for the finance director / multi-branch dashboard. Not branch-scoped.',
      permissions: roles('admin', 'finance_admin'),
      wrapHandler: false,
      handler: async (_req: any, reply: any) => {
        const today = bdToday();

        // Pull all branch states + branch metadata in two parallel queries.
        // Branches with no DayCloseState row appear with daysBehind=null
        // (never closed before).
        const db = mongoose.connection.db!;
        const [states, orgs] = await Promise.all([
          DayCloseState.find({}).select('branchId lastClosedDate').lean(),
          db
            .collection('organization')
            .find({}, { projection: { _id: 1, name: 1, slug: 1 } })
            .toArray(),
        ]);

        const stateByBranch = new Map<string, string>();
        for (const s of states as Array<{ branchId: mongoose.Types.ObjectId; lastClosedDate: string }>) {
          stateByBranch.set(s.branchId.toString(), s.lastClosedDate);
        }

        function daysBetween(fromBd: string, toBd: string): number {
          const f = new Date(`${fromBd}T00:00:00Z`).getTime();
          const t = new Date(`${toBd}T00:00:00Z`).getTime();
          return Math.max(0, Math.round((t - f) / (1000 * 60 * 60 * 24)));
        }

        const branches = orgs.map((o: any) => {
          const id = o._id.toString();
          const lastClosedDate = stateByBranch.get(id) ?? null;
          const daysBehind = lastClosedDate ? daysBetween(lastClosedDate, today) : null;
          return {
            branchId: id,
            branchName: o.name ?? o.slug ?? null,
            lastClosedDate,
            daysBehind,
            currentBdDate: today,
          };
        });

        const branchesBehind = branches.filter((b) => (b.daysBehind ?? 99) > 1).length;
        const maxDaysBehind = branches.reduce(
          (max, b) => (b.daysBehind != null && b.daysBehind > max ? b.daysBehind : max),
          0,
        );

        return reply.send({
          success: true,
          data: {
            branches,
            summary: {
              totalBranches: branches.length,
              branchesBehind,
              maxDaysBehind,
              currentBdDate: today,
            },
          },
        });
      },
    },
    {
      method: 'GET',
      path: '/status',
      summary: 'Get posting status for today and yesterday',
      description: 'Returns whether POS books are open/closed for dashboard display.',
      permissions: authenticated,
      wrapHandler: false,
      handler: async (req: any, reply: any) => {
        const orgId = req.scope?.organizationId;
        if (!orgId) {
          return reply.status(400).send({ success: false, message: 'Organization context required' });
        }

        const today = bdToday();
        const yesterday = bdYesterday();

        const [todayEntry, yesterdayEntry] = await Promise.all([
          JournalEntry.findOne({
            organizationId: orgId,
            idempotencyKey: `pos-daily-${orgId}-${today}`,
          })
            .select('_id state createdAt')
            .lean(),
          JournalEntry.findOne({
            organizationId: orgId,
            idempotencyKey: `pos-daily-${orgId}-${yesterday}`,
          })
            .select('_id state createdAt')
            .lean(),
        ]);

        return reply.send({
          success: true,
          data: {
            today: {
              date: today,
              closed: !!todayEntry,
              entry: todayEntry ? { id: (todayEntry as Record<string, unknown>)._id, state: (todayEntry as Record<string, unknown>).state } : null,
            },
            yesterday: {
              date: yesterday,
              closed: !!yesterdayEntry,
              entry: yesterdayEntry ? { id: (yesterdayEntry as Record<string, unknown>)._id, state: (yesterdayEntry as Record<string, unknown>).state } : null,
            },
          },
        });
      },
    },
  ],
});

export default postingResource;
