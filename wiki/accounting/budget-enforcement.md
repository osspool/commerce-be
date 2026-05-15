# Budget enforcement

Plugin on the JournalEntry repository that intercepts `before:update` and
`before:claim` (the two paths that transition state to `posted`). For
each journal item's debit, look up an approved budget and enforce per
`actionIfExceeded`.

```
journalEntryRepository.post(jeId)
  → repo.claim({state:'posted'})       ledger 0.10+ atomic CAS
      → before:claim hook fires        budget-enforcement-plugin.ts
          → load JE { organizationId, date, journalItems }
          → for each journalItem with debit > 0:
                debitsByAccount[account] += debit
          → Budget.find({
                organizationId,
                account: { $in: accountIds },
                status: 'approved',
                actionIfExceeded: { $ne: 'ignore' },    ← filter per-budget mode
                periodStart: { $lte: date },
                periodEnd: { $gte: date },
            })
          → for each matched budget:
                periodActual = sum(posted JEs for budget.account, period)
                projected = periodActual + newDebit
                threshold = budget.amount * budget.thresholdPercent / 100
                if projected > threshold:
                    actionIfExceeded === 'stop' → throw 422 BUDGET_EXCEEDED
                    actionIfExceeded === 'warn' → publish event + log, continue
```

## Per-budget vs company-wide

Each Budget doc has its OWN `actionIfExceeded` field. The plugin respects
that — company-wide config only sets the DEFAULT at create time.

```
                                ┌─ Per-budget actionIfExceeded
                                │  (set on Budget doc, can be edited)
schema default ─→ Budget.create
  ↑
  config.accounting.budget.defaultActionIfExceeded
  ↑
  BUDGET_DEFAULT_ENFORCEMENT env (stop | warn | ignore | unset→ignore)
```

The plugin reads ONLY `budget.actionIfExceeded`. The env var affects new
budgets only; existing budgets keep whatever they were created with.

## Why "no encumbrance" is a REAL gap

The plugin runs at POST time — sums existing-posted + new debit. Between
two concurrent posts that each see the budget as fine, BOTH can succeed
even if their combined total exceeds the budget. There's no commitment
table that says "supplier X has 50k reserved against this budget,
pending bill post."

Adding encumbrance would require:
1. A `BudgetCommitment` collection (org+account+period+pending amount).
2. PO approval triggers a commitment write.
3. Plugin reads `committed` in addition to `posted` when computing actual.
4. Bill post decreases commitment as it adds to posted.

Not implemented. See [erp-gaps.md](../erp-gaps.md) row 34.

## Files

| File | Purpose |
|---|---|
| [posting/budget-enforcement-plugin.ts](../../src/resources/accounting/posting/budget-enforcement-plugin.ts) | the plugin itself |
| [accounting.engine.ts](../../src/resources/accounting/accounting.engine.ts) | wires the plugin onto journalEntryRepository; schema defaults source from config |
| [budget/budget.resource.ts](../../src/resources/accounting/budget/budget.resource.ts) | Budget CRUD + maker-checker actions |
| [config/sections/accounting.config.ts](../../src/config/sections/accounting.config.ts) | `BUDGET_DEFAULT_ENFORCEMENT` + `BUDGET_DEFAULT_THRESHOLD_PERCENT` env reading |

## Tests

- `tests/unit/budget-default-enforcement.test.ts` — subprocess behavior tests (env var → config)
- `tests/unit/budget-default-enforcement-contract.test.ts` — schema wiring contract

## Gotchas

- **Only debit-side enforcement.** Credit budgets (revenue floors) are
  intentionally out of scope. Comment lines 22–24 of the plugin.
- **Reversals are exempt** via `_ledgerInternal === 'reverseMark'`.
  Reversing an over-budget entry shouldn't trip the guard.
- **Entry date drives period match.** A JE dated 2026-04-30 posted in
  May still matches the April budget. We do NOT split JEs across periods.
- **`status: 'approved'` is required.** Draft budgets are ignored.
  Approve workflow is in `budget.actions.ts`.
- **Sparse index** on `(orgId, account, periodStart, periodEnd, status)`
  drives the lookup. The Budget schema declares this in `extraIndexes`.
