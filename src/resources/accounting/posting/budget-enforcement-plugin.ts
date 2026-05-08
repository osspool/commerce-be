/**
 * Budget Enforcement Plugin
 *
 * Hooks the JE post pipeline. When a JE transitions draft → posted, for each
 * journalItem this plugin:
 *   1. Looks up an APPROVED, NON-IGNORED Budget for `(organizationId, account,
 *      periodStart..periodEnd containing entry.date)`.
 *   2. If found, sums existing posted JE debits for that same (org, account,
 *      period) — the period actual.
 *   3. Adds this entry's debit on that account.
 *   4. Compares projected total to `budget.amount * thresholdPercent / 100`.
 *   5. Acts per `budget.actionIfExceeded`:
 *        - `stop`   → throw 422 BUDGET_EXCEEDED, JE post fails
 *        - `warn`   → publish `accounting:budget.threshold.exceeded`, JE still posts
 *        - `ignore` → no-op (skipped at lookup time via the index filter)
 *
 * Mirrors ERPNext's `validate_expense_against_budget()` semantics — the
 * difference being we run on EVERY JE post (not just MR/PO/Journal Entry
 * specifically), so a payroll JE auto-posted from HRM is constrained by the
 * same budget that constrains a manual JE from finance.
 *
 * Scope:
 *   - Only DEBIT-side enforcement (expense accounts increase on debit). Credit
 *     budgets (revenue floors) are a separate mode — out of scope for v1.
 *   - Only ENTRY-DATE-DRIVEN: budget period is matched to `entry.date`. We do
 *     NOT split a single JE across two periods (overlap is rare in practice,
 *     and ERPNext doesn't either).
 *   - Reversals via `_ledgerInternal === 'reverseMark'` are exempt — reversing
 *     an over-budget entry shouldn't itself trip the guard.
 */

import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';

interface JournalItemSnapshot {
  account: unknown;
  debit?: number;
  credit?: number;
}

interface BudgetDoc {
  _id: unknown;
  account: unknown;
  amount: number;
  organizationId?: unknown;
  periodStart: Date;
  periodEnd: Date;
  actionIfExceeded: 'stop' | 'warn' | 'ignore';
  thresholdPercent: number;
  status: string;
}

/** Lazy model proxy — defers lookup to runtime so module-init order doesn't matter. */
function lazyModel(name: string): Model<unknown> {
  let cached: Model<unknown> | null = null;
  return new Proxy({} as Model<unknown>, {
    get(_target, prop, receiver) {
      if (!cached) cached = mongoose.connection.model(name) as Model<unknown>;
      return Reflect.get(cached, prop, receiver);
    },
  });
}

export function budgetEnforcementPlugin() {
  const Budget = lazyModel('Budget');
  const JournalEntry = lazyModel('JournalEntry');

  return {
    name: 'accounting:budget-enforcement',
    apply(repo: RepositoryInstance) {
      // Shared enforcement body. Called from both `before:update` and
      // `before:claim` so the plugin fires regardless of which write path
      // posts the entry. Ledger 0.10.x routes JE post through `repo.claim()`
      // (atomic CAS); legacy / direct callers still hit `repo.update()`.
      const enforce = async (entryId: unknown, isReversal: boolean) => {
        if (!entryId) return;
        if (isReversal) return;

        const persisted = (await JournalEntry.findById(entryId)
          .select('organizationId date journalItems')
          .lean()) as
          | {
              organizationId?: unknown;
              date?: Date;
              journalItems?: JournalItemSnapshot[];
            }
          | null;
        if (!persisted) return;
        const { organizationId, date, journalItems = [] } = persisted;
        if (!organizationId || !date || journalItems.length === 0) return;

        // Group debits by account — one budget check per distinct account.
        const debitsByAccount = new Map<string, number>();
        for (const item of journalItems) {
          if (!item.account) continue;
          const debit = Number(item.debit ?? 0);
          if (debit <= 0) continue; // budget enforcement is debit-side only
          const key = String(item.account);
          debitsByAccount.set(key, (debitsByAccount.get(key) ?? 0) + debit);
        }
        if (debitsByAccount.size === 0) return;

        // Find approved, non-ignored budgets for the (org, account, date) tuple.
        const accountIds = Array.from(debitsByAccount.keys()).map(
          (id) => new mongoose.Types.ObjectId(id),
        );
        const budgets = (await Budget.find({
          organizationId,
          account: { $in: accountIds },
          status: 'approved',
          actionIfExceeded: { $ne: 'ignore' },
          periodStart: { $lte: date },
          periodEnd: { $gte: date },
        }).lean()) as unknown as BudgetDoc[];
        if (budgets.length === 0) return;

        // For each matched budget, compute period-actual + new debit.
        for (const budget of budgets) {
          const accountKey = String(budget.account);
          const newDebit = debitsByAccount.get(accountKey) ?? 0;

          const actualAgg = (await JournalEntry.aggregate([
            {
              $match: {
                organizationId,
                state: 'posted',
                date: { $gte: budget.periodStart, $lte: budget.periodEnd },
                _id: { $ne: new mongoose.Types.ObjectId(String(entryId)) },
              },
            },
            { $unwind: '$journalItems' },
            { $match: { 'journalItems.account': new mongoose.Types.ObjectId(accountKey) } },
            { $group: { _id: null, total: { $sum: '$journalItems.debit' } } },
          ])) as Array<{ total?: number }>;

          const periodActual = actualAgg[0]?.total ?? 0;
          const projected = periodActual + newDebit;
          const threshold = Math.floor((budget.amount * budget.thresholdPercent) / 100);
          if (projected <= threshold) continue;

          const overage = projected - threshold;
          if (budget.actionIfExceeded === 'stop') {
            throw Object.assign(
              new Error(
                `BUDGET_EXCEEDED: account ${accountKey} would post ${projected} paisa against budget threshold ${threshold} paisa (overage ${overage}). Budget ${budget._id}.`,
              ),
              {
                statusCode: 422,
                code: 'BUDGET_EXCEEDED',
                budgetId: String(budget._id),
                account: accountKey,
                periodActual,
                newDebit,
                projected,
                threshold,
                budgetAmount: budget.amount,
                thresholdPercent: budget.thresholdPercent,
              },
            );
          }
          // warn — fire-and-forget event for monitoring + finance dashboard
          await publish('accounting:budget.threshold.exceeded', {
            budgetId: String(budget._id),
            organizationId: String(organizationId),
            account: accountKey,
            entryId: String(entryId),
            periodActual,
            newDebit,
            projected,
            threshold,
            budgetAmount: budget.amount,
            thresholdPercent: budget.thresholdPercent,
            date: new Date().toISOString(),
          });
          logger.warn(
            {
              budgetId: String(budget._id),
              account: accountKey,
              projected,
              threshold,
              overage,
            },
            'budget-enforcement: threshold exceeded (warn)',
          );
        }
      };

      // before:update — fires on legacy repo.update({state: 'posted'}) callers.
      repo.on('before:update', async (ctx: RepositoryContext) => {
        const update = ctx.data as Record<string, unknown> & { state?: string };
        if (update.state !== 'posted') return;
        const isReversal = (update as { _ledgerInternal?: string })._ledgerInternal === 'reverseMark';
        await enforce(ctx.id, isReversal);
      });

      // before:claim — fires on ledger 0.10.x's atomic CAS post path
      // (journalEntryRepository.post() → claim()). The mongokit `claim()` op
      // exposes the `$set` payload as ctx.data, so we detect the post by
      // `$set.state === 'posted'` rather than the spec's `from/to`.
      repo.on('before:claim', async (ctx: RepositoryContext) => {
        const data = ctx.data as { $set?: Record<string, unknown> } | undefined;
        if (data?.$set?.state !== 'posted') return;
        await enforce(ctx.id, false);
      });
    },
  };
}
